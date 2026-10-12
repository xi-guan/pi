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
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Codegraph, indexPath } from "./codegraph.ts";
import { type DedupResult, evaluateToolCall, findNearDuplicates } from "./dedup.ts";
import { buildInventory, extractKeywords, formatInventory, PLAN_GATE_RULES } from "./inventory.ts";
import { formatNoteLines, formatNotesBlock, loadNotes, matchNotes } from "./notes.ts";
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

export default function (pi: ExtensionAPI) {
	// the index is keyed by project root, so every hook refreshes this from ctx.cwd
	let projectRoot = process.cwd();
	const codegraph = new Codegraph(() => projectRoot);
	const state: LegoState = { byToolCall: new Map(), blockedCount: 0, reviewFails: 0, semanticFlags: [] };

	/** L2 recall for one reviewed edit; failure degrades to no suspects. */
	async function collectSemanticSuspects(dedup: DedupResult, addedText: string): Promise<SemanticSuspect[]> {
		try {
			return await findCalleeSuspects(addedText, dedup.newSymbols, dedup.candidates, dedup.path, (name) =>
				codegraph.callees(name),
			);
		} catch {
			// callee signal unavailable — review still runs, just without suspects
			return [];
		}
	}

	// 1 + 2 — inject brick inventory and append plan-gate rules per turn
	pi.on("before_agent_start", async (event, ctx) => {
		// idle custom-message runs carry no prompt to mine; they never reached this hook before 1.x
		if (event.messageType !== "user") return undefined;
		try {
			if (ctx?.cwd) projectRoot = ctx.cwd;
			const noteLines = formatNoteLines(matchNotes(event.prompt, await loadNotes(projectRoot)));
			// records are independent of the index, so they still ship when the hooks are no-ops
			if (!(await codegraph.available())) {
				if (noteLines.length === 0) return undefined;
				return { message: { customType: "lego-notes", content: formatNotesBlock(noteLines), display: true } };
			}
			const systemPrompt = event.systemPrompt + PLAN_GATE_RULES;
			const keywords = extractKeywords(event.prompt);
			const results = await Promise.all(keywords.map((keyword) => codegraph.query(keyword, 8)));
			const symbols = buildInventory(results);
			const sections = [
				symbols.length > 0 ? formatInventory(symbols) : "",
				noteLines.length > 0 ? formatNotesBlock(noteLines) : "",
			].filter((section) => section.length > 0);
			if (sections.length === 0) return { systemPrompt };
			return {
				systemPrompt,
				message: {
					customType: "lego-inventory",
					content: sections.join("\n\n"),
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

			const addedText = addedTextOf(input);
			const suspects = await collectSemanticSuspects(dedup, addedText);
			const suspectLines = formatSuspects(suspects);
			state.semanticFlags.push(...suspectLines.map((line) => line.replace(/^- /, "")));

			const notes = await loadNotes(projectRoot);
			const noteLines = formatNoteLines(matchNotes([...names, addedText].join("\n"), notes));

			const { complete } = await import("@earendil-works/pi-ai/compat");
			const response = await Promise.race([
				complete(
					model,
					{
						messages: [
							{
								role: "user" as const,
								content: [
									{ type: "text" as const, text: buildReviewPrompt(names, diff, neighborLines, suspectLines, noteLines) },
								],
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
		description: "Lego loop status (reuse-first hooks)",
		handler: async (_args, ctx) => {
			if (ctx?.cwd) projectRoot = ctx.cwd;
			const ok = await codegraph.available();
			const status = ok
				? `code index available — hooks active (${indexPath(ctx.cwd)})`
				: `code index MISSING — hooks are no-ops (index this repo with codebase-memory-mcp; expected ${indexPath(ctx.cwd)})`;
			if (ctx.hasUI) ctx.ui.notify(`lego: ${status}`, ok ? "info" : "warning");
		},
	});
}
