/**
 * Lego loop — reuse-first coding agent hooks (v1).
 *
 * 1  Inventory   before_agent_start: inject brick list from the code index
 * 2  Plan gate   before_agent_start: append REUSE/EXTEND/NEW rules to system prompt
 * 3a Dedup       tool_call(edit/write): hard-block near-duplicate new symbols
 * 3b Review      tool_result(edit/write): LLM brick review, soft bounce
 * 4  Verify      agent_end: reuse/new/dup metrics -> .pi/lego-metrics.jsonl
 *
 * Degrades to no-ops when the codebase-memory-mcp index is missing.
 */
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Codegraph, indexPath, projectSlug } from "./codegraph.ts";
import { type DedupResult, evaluateToolCall, findNearDuplicates } from "./dedup.ts";
import {
	buildEmbeddingIndex,
	type EmbedConfig,
	type EmbeddingIndex,
	embedTexts,
	parseEmbedConfig,
	rankSuspects,
	type SymbolSpan,
} from "./embed.ts";
import { buildInventory, extractKeywords, formatInventory, PLAN_GATE_RULES } from "./inventory.ts";
import { applyVerdict, buildReviewPrompt, parseVerdict } from "./review.ts";
import { findCalleeSuspects, formatSuspects, type SemanticSuspect } from "./semantic.ts";
import { aggregateStats, collectRunData, countReusedCalls } from "./verify.ts";

/** Per-run state shared across hooks (3a feeds 3b and 4). */
export interface LegoState {
	/** Dedup outcome per toolCallId, for review (3b) and metrics (4). */
	byToolCall: Map<string, DedupResult>;
	blockedCount: number;
	reviewFails: number;
	/** Formatted semantic-duplicate suspects surfaced to the reviewer this run. */
	semanticFlags: string[];
}

const REVIEW_TIMEOUT_MS = 30_000;
const REVIEW_DIFF_CAP = 4000;
const EMBED_QUERY_TIMEOUT_MS = 3_000;
const EMBED_CONFIG_FILE = "lego.local.json";
const EMBED_INDEX_FILE = "lego-embeddings.json";

/** New code introduced by an edit/write call, for semantic fingerprinting. */
function addedTextOf(input: Record<string, unknown>): string {
	if (typeof input.content === "string") return input.content;
	const edits = Array.isArray(input.edits) ? input.edits : [input];
	return edits
		.map((edit) => {
			const newText = (edit as { newText?: unknown })?.newText;
			return typeof newText === "string" ? newText : "";
		})
		.join("\n");
}

/** function/method spans straight from the codebase-memory sqlite index; [] on any failure. */
async function listSymbolSpans(cwd: string): Promise<SymbolSpan[]> {
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(indexPath(cwd), { readOnly: true });
		try {
			const rows = db
				.prepare(
					`SELECT name, lower(label) AS kind, file_path AS filePath, start_line AS startLine, end_line AS endLine
					 FROM nodes
					 WHERE project = ?
					   AND label IN ('Function', 'Method')
					   AND end_line - start_line >= 2
					   AND json_extract(properties, '$.is_test') IS NOT 1
					 GROUP BY file_path, name, end_line`,
				)
				.all(projectSlug(cwd)) as unknown as SymbolSpan[];
			return rows.filter((r) => typeof r.name === "string" && typeof r.filePath === "string");
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

/** Body reader for index building, with a per-build file cache. */
function makeBodyReader(cwd: string): (span: SymbolSpan) => string | undefined {
	const fileCache = new Map<string, string[] | undefined>();
	return (span) => {
		if (!fileCache.has(span.filePath)) {
			try {
				fileCache.set(span.filePath, readFileSync(join(cwd, span.filePath), "utf8").split("\n"));
			} catch {
				fileCache.set(span.filePath, undefined);
			}
		}
		const lines = fileCache.get(span.filePath);
		return lines ? lines.slice(span.startLine - 1, span.endLine).join("\n") : undefined;
	};
}

export default function (pi: ExtensionAPI) {
	// the index is keyed by project root, so every hook refreshes this from ctx.cwd
	let projectRoot = process.cwd();
	const codegraph = new Codegraph(() => projectRoot);
	const state: LegoState = { byToolCall: new Map(), blockedCount: 0, reviewFails: 0, semanticFlags: [] };

	// L3 backend: config and index are both optional; missing → embedding no-ops
	let embedConfig: EmbedConfig | undefined;
	let embeddingIndex: EmbeddingIndex | undefined | null; // null = load attempted, absent
	async function loadEmbedding(cwd: string): Promise<{ config: EmbedConfig; index: EmbeddingIndex } | undefined> {
		if (typeof cwd !== "string" || !cwd) return undefined;
		if (embedConfig === undefined) {
			embedConfig = parseEmbedConfig(await readFile(join(cwd, ".pi", EMBED_CONFIG_FILE), "utf8").catch(() => undefined));
		}
		if (!embedConfig) return undefined;
		if (embeddingIndex === undefined) {
			try {
				embeddingIndex = JSON.parse(await readFile(join(cwd, ".pi", EMBED_INDEX_FILE), "utf8")) as EmbeddingIndex;
			} catch {
				embeddingIndex = null;
			}
		}
		if (!embeddingIndex || embeddingIndex.model !== embedConfig.model) return undefined;
		return { config: embedConfig, index: embeddingIndex };
	}

	/** L2 + L3 recall for one reviewed edit; failures degrade to fewer suspects. */
	async function collectSemanticSuspects(
		dedup: DedupResult,
		addedText: string,
		cwd: string,
	): Promise<SemanticSuspect[]> {
		const suspects: SemanticSuspect[] = [];
		try {
			suspects.push(
				...(await findCalleeSuspects(addedText, dedup.newSymbols, dedup.candidates, dedup.path, (name) =>
					codegraph.callees(name),
				)),
			);
		} catch {
			// callee signal unavailable — embedding may still fire
		}
		try {
			const embedding = await loadEmbedding(cwd);
			if (embedding && addedText.trim()) {
				const vectors = await Promise.race([
					embedTexts(embedding.config, [addedText], fetch),
					new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), EMBED_QUERY_TIMEOUT_MS)),
				]);
				if (vectors) {
					suspects.push(...rankSuspects(vectors[0], embedding.index, dedup.path, dedup.newSymbols[0]?.name ?? ""));
				}
			}
		} catch {
			// embedding backend down — deterministic signals already collected
		}
		return suspects;
	}

	// 1 + 2 — inject brick inventory and append plan-gate rules per turn
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (ctx?.cwd) projectRoot = ctx.cwd;
			if (!(await codegraph.available())) return undefined;
			const systemPrompt = event.systemPrompt + PLAN_GATE_RULES;
			const keywords = extractKeywords(event.prompt);
			if (keywords.length === 0) return { systemPrompt };
			const results = await Promise.all(keywords.map((keyword) => codegraph.query(keyword, 8)));
			const symbols = buildInventory(results);
			if (symbols.length === 0) return { systemPrompt };
			return {
				systemPrompt,
				message: {
					customType: "lego-inventory",
					content: formatInventory(symbols),
					display: true,
				},
			};
		} catch {
			// lego must never break the base agent
			return undefined;
		}
	});

	// 3a — hard block near-duplicate new symbols before edit/write executes
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (ctx?.cwd) projectRoot = ctx.cwd;
			if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
			const result = await evaluateToolCall(event.toolName, event.input as Record<string, unknown>, codegraph);
			if (!result) return undefined;
			if (result.reason) {
				state.blockedCount++;
				return { block: true, reason: result.reason };
			}
			state.byToolCall.set(event.toolCallId, result);
			return undefined;
		} catch {
			// lego must never break the base agent
			return undefined;
		}
	});

	// 3b — LLM brick review of newly added symbols; soft bounce on FAIL
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (ctx?.cwd) projectRoot = ctx.cwd;
			if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
			if (event.isError) return undefined;
			const dedup = state.byToolCall.get(event.toolCallId);
			if (!dedup || dedup.newSymbols.length === 0) return undefined;

			const model = ctx.model;
			if (!model) return undefined;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) return undefined;

			const input = event.input as Record<string, unknown>;
			const details = event.details as { diff?: string } | undefined;
			const diff = (details?.diff ?? (typeof input.content === "string" ? input.content : "")).slice(
				0,
				REVIEW_DIFF_CAP,
			);
			if (!diff) return undefined;

			const names = dedup.newSymbols.map((d) => d.name);
			const neighborLists = await Promise.all(names.map((name) => codegraph.query(name, 3)));
			const neighborLines = buildInventory(neighborLists, 10).map(
				(s) => `- ${s.name} (${s.kind}) — ${s.filePath}:${s.startLine}${s.signature ? ` — ${s.signature}` : ""}`,
			);

			const suspects = await collectSemanticSuspects(dedup, addedTextOf(input), ctx.cwd);
			const suspectLines = formatSuspects(suspects);
			state.semanticFlags.push(...suspectLines.map((line) => line.replace(/^- /, "")));

			const { complete } = await import("@earendil-works/pi-ai/compat");
			const response = await Promise.race([
				complete(
					model,
					{
						messages: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: buildReviewPrompt(names, diff, neighborLines, suspectLines) }],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
				),
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), REVIEW_TIMEOUT_MS)),
			]);
			if (!response) return undefined;

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const verdict = parseVerdict(text);
			if (verdict.pass) return undefined;

			state.reviewFails++;
			const content = applyVerdict(event.content as Array<{ type: "text"; text?: string }>, verdict);
			return content ? { content: content as never } : undefined;
		} catch {
			// lego must never break the base agent
			return undefined;
		}
	});

	// 4 — verify: reuse metrics per agent run, persisted as eval data
	pi.on("agent_end", async (event, ctx) => {
		try {
			if (ctx?.cwd) projectRoot = ctx.cwd;
			const data = collectRunData(event.messages as never);
			if (data.editCount === 0 && state.blockedCount === 0) return;

			const reusedCalls = await countReusedCalls(data.addedText, async (name) =>
				(await codegraph.query(name, 5)).some((s) => s.name === name),
			);
			const missedDuplicates: string[] = [];
			for (const entry of state.byToolCall.values()) {
				// escaped decls were caught and consciously let through; they are not misses
				const unescaped = entry.newSymbols.filter((d) => d.escapeReason === undefined);
				for (const hit of await findNearDuplicates(unescaped, entry.path, codegraph)) {
					missedDuplicates.push(`${hit.decl.name} ≈ ${hit.match.name} (${hit.match.filePath}:${hit.match.startLine})`);
				}
			}
			const entries = [...state.byToolCall.values()];
			const stats = aggregateStats({
				editCount: data.editCount,
				newSymbols: [...new Set(entries.flatMap((r) => r.newSymbols.map((d) => d.name)))],
				escapes: entries.flatMap((r) => r.escaped.map((d) => ({ name: d.name, reason: d.escapeReason ?? "" }))),
				blockedCount: state.blockedCount,
				reviewFails: state.reviewFails,
				reusedCalls,
				missedDuplicates,
				semanticFlags: [...state.semanticFlags],
			});

			pi.appendEntry("lego-verify", stats);
			const metricsDir = join(ctx.cwd, ".pi");
			await mkdir(metricsDir, { recursive: true });
			await appendFile(
				join(metricsDir, "lego-metrics.jsonl"),
				`${JSON.stringify({ timestamp: new Date().toISOString(), ...stats })}\n`,
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`lego: ${stats.reusedCalls} reuse / ${stats.newSymbols.length} new / ${stats.blocked} blocked / ${stats.missedDuplicates.length} dup-missed`,
					stats.missedDuplicates.length > 0 ? "warning" : "info",
				);
			}
		} catch {
			// lego must never break the base agent
		} finally {
			state.byToolCall.clear();
			state.blockedCount = 0;
			state.reviewFails = 0;
			state.semanticFlags = [];
		}
	});

	pi.registerCommand("lego", {
		description: "Lego loop status (reuse-first hooks); `/lego embed` (re)builds the embedding index",
		handler: async (args, ctx) => {
			if (ctx?.cwd) projectRoot = ctx.cwd;
			const notify = (message: string, level: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			};

			if (args?.trim() === "embed") {
				embedConfig = undefined; // re-read config so key/model edits take effect
				const config = parseEmbedConfig(
					await readFile(join(ctx.cwd, ".pi", EMBED_CONFIG_FILE), "utf8").catch(() => undefined),
				);
				if (!config) {
					notify(`lego embed: no usable .pi/${EMBED_CONFIG_FILE} (embedding.baseUrl/apiKey/model)`, "warning");
					return;
				}
				const spans = await listSymbolSpans(ctx.cwd);
				if (spans.length === 0) {
					notify("lego embed: no symbol spans (code index missing?)", "warning");
					return;
				}
				notify(`lego embed: embedding ${spans.length} symbols via ${config.model}…`);
				try {
					const index = await buildEmbeddingIndex(config, spans, makeBodyReader(ctx.cwd), fetch);
					await writeFile(join(ctx.cwd, ".pi", EMBED_INDEX_FILE), JSON.stringify(index));
					embedConfig = config;
					embeddingIndex = index;
					notify(`lego embed: indexed ${index.entries.length} symbol bodies → .pi/${EMBED_INDEX_FILE}`);
				} catch (error) {
					notify(`lego embed: failed — ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
				return;
			}

			const ok = await codegraph.available();
			const status = ok
				? `code index available — hooks active (${indexPath(ctx.cwd)})`
				: `code index MISSING — hooks are no-ops (index this repo with codebase-memory-mcp; expected ${indexPath(ctx.cwd)})`;
			const embedding = await loadEmbedding(ctx.cwd);
			const embedStatus = embedding
				? `embedding index: ${embedding.index.entries.length} symbols (${embedding.index.model}, built ${embedding.index.builtAt})`
				: "embedding index: absent — L3 off (`/lego embed` to build)";
			notify(`lego v2: ${status}; ${embedStatus}`, ok ? "info" : "warning");
		},
	});
}
