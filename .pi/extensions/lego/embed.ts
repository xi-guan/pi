/**
 * L3 — embedding-based semantic recall (optional, self-hosted backend).
 *
 * Absolute cosine thresholds do not work on code (all same-language snippets
 * sit in a narrow cone, calibrated 2026-07-06: duplicates z 3.4-4.6, novel
 * code z ≤ 2.3), so suspects are judged by z-score against the whole index
 * plus an absolute floor. Missing config, index, or backend → callers no-op.
 */
import type { CgSymbol } from "./codegraph.ts";
import { isSameFile } from "./dedup.ts";
import type { SemanticSuspect } from "./semantic.ts";

export interface EmbedConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export interface SymbolSpan {
	name: string;
	kind: string;
	filePath: string;
	startLine: number;
	endLine: number;
}

export interface EmbeddingIndexEntry {
	name: string;
	kind: string;
	filePath: string;
	startLine: number;
	vector: number[];
}

export interface EmbeddingIndex {
	model: string;
	builtAt: string;
	entries: EmbeddingIndexEntry[];
}

export const EMBED_Z_THRESHOLD = 3.0;
export const EMBED_SCORE_FLOOR = 0.85;
export const EMBED_TOP_K = 3;
/** Below this many comparable entries, mean/sd are too unstable to trust. */
const MIN_INDEX_SIZE = 20;
/** Bodies shorter than this carry no embeddable signal (imports, stubs). */
const MIN_BODY_CHARS = 60;
/** Keep well under bge-m3's 8k-token window. */
const MAX_BODY_CHARS = 6000;
const BATCH_SIZE = 16;

/** Parse .pi/lego.local.json content; undefined unless all fields present. */
export function parseEmbedConfig(raw: string | undefined): EmbedConfig | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { embedding?: Record<string, unknown> };
		const embedding = parsed.embedding ?? {};
		const { baseUrl, apiKey, model } = embedding as Record<string, unknown>;
		if (typeof baseUrl !== "string" || !baseUrl) return undefined;
		if (typeof apiKey !== "string" || !apiKey) return undefined;
		if (typeof model !== "string" || !model) return undefined;
		return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
	} catch {
		return undefined;
	}
}

/** OpenAI-compatible /embeddings, batched; throws on transport/http errors. */
export async function embedTexts(
	config: EmbedConfig,
	texts: string[],
	fetchFn: typeof fetch,
): Promise<number[][]> {
	const vectors: number[][] = [];
	for (let i = 0; i < texts.length; i += BATCH_SIZE) {
		const batch = texts.slice(i, i + BATCH_SIZE).map((t) => t.slice(0, MAX_BODY_CHARS));
		const response = await fetchFn(`${config.baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: config.model, input: batch }),
		});
		if (!response.ok) throw new Error(`embeddings ${response.status}`);
		const json = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
		const sorted = [...json.data].sort((a, b) => a.index - b.index);
		for (const item of sorted) vectors.push(item.embedding);
	}
	return vectors;
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denominator = Math.sqrt(normA * normB);
	return denominator === 0 ? 0 : dot / denominator;
}

/** Entries that are z-score outliers above the code cone AND above the floor. */
export function rankSuspects(
	queryVector: number[],
	index: EmbeddingIndex,
	editedPath: string,
	declName: string,
): SemanticSuspect[] {
	const comparable = index.entries.filter((entry) => !isSameFile(editedPath, entry.filePath));
	if (comparable.length < MIN_INDEX_SIZE) return [];

	const scored = comparable.map((entry) => ({ entry, score: cosine(queryVector, entry.vector) }));
	const mean = scored.reduce((sum, s) => sum + s.score, 0) / scored.length;
	const sd = Math.sqrt(scored.reduce((sum, s) => sum + (s.score - mean) ** 2, 0) / scored.length);

	return scored
		.filter(({ score }) => {
			if (score < EMBED_SCORE_FLOOR) return false;
			const z = sd < 1e-6 ? 0 : (score - mean) / sd;
			return z >= EMBED_Z_THRESHOLD;
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, EMBED_TOP_K)
		.map(({ entry, score }) => ({
			declName,
			match: toSymbol(entry),
			via: "embedding" as const,
			score,
			detail: `cosine ${score.toFixed(3)} (corpus mean ${mean.toFixed(3)})`,
		}));
}

function toSymbol(entry: EmbeddingIndexEntry): CgSymbol {
	return { name: entry.name, kind: entry.kind, filePath: entry.filePath, startLine: entry.startLine };
}

/** Embed every readable symbol body into a fresh index. */
export async function buildEmbeddingIndex(
	config: EmbedConfig,
	spans: SymbolSpan[],
	readBody: (span: SymbolSpan) => string | undefined,
	fetchFn: typeof fetch,
	onProgress?: (done: number, total: number) => void,
): Promise<EmbeddingIndex> {
	const embeddable: Array<{ span: SymbolSpan; body: string }> = [];
	for (const span of spans) {
		const body = readBody(span);
		if (body && body.trim().length >= MIN_BODY_CHARS) embeddable.push({ span, body });
	}

	const entries: EmbeddingIndexEntry[] = [];
	for (let i = 0; i < embeddable.length; i += BATCH_SIZE) {
		const batch = embeddable.slice(i, i + BATCH_SIZE);
		const vectors = await embedTexts(config, batch.map((e) => e.body), fetchFn);
		for (let j = 0; j < batch.length; j++) {
			const { span } = batch[j];
			entries.push({
				name: span.name,
				kind: span.kind,
				filePath: span.filePath,
				startLine: span.startLine,
				vector: vectors[j],
			});
		}
		onProgress?.(Math.min(i + BATCH_SIZE, embeddable.length), embeddable.length);
	}
	return { model: config.model, builtAt: new Date().toISOString(), entries };
}
