import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildEmbeddingIndex,
	cosine,
	EMBED_SCORE_FLOOR,
	type EmbeddingIndex,
	embedTexts,
	parseEmbedConfig,
	rankSuspects,
} from "./embed.ts";

const CONFIG_JSON = JSON.stringify({
	embedding: { baseUrl: "http://localhost:8200/v1", apiKey: "omlx-test", model: "bge-m3-mlx-8bit" },
});

const CONFIG = parseEmbedConfig(CONFIG_JSON);
if (!CONFIG) throw new Error("test fixture config must parse");

// ── parseEmbedConfig

test("parses embedding config and rejects incomplete or invalid input", () => {
	assert.equal(CONFIG.model, "bge-m3-mlx-8bit");
	assert.equal(CONFIG.baseUrl, "http://localhost:8200/v1");
	assert.equal(parseEmbedConfig(undefined), undefined);
	assert.equal(parseEmbedConfig("not json"), undefined);
	assert.equal(parseEmbedConfig(JSON.stringify({ embedding: { baseUrl: "x" } })), undefined);
});

// ── cosine

test("cosine similarity of identical and orthogonal vectors", () => {
	assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
	assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

// ── embedTexts

function fakeEmbedFetch(calls: Array<{ url: string; body: Record<string, unknown> }>) {
	return async (url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		calls.push({ url: String(url), body });
		const input = body.input as string[];
		// reversed order to prove embedTexts sorts by index
		const data = input.map((_, i) => ({ index: i, embedding: [i + calls.length, 1] })).reverse();
		return new Response(JSON.stringify({ data }), { status: 200 });
	};
}

test("embedTexts batches requests and returns vectors in input order", async () => {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const texts = Array.from({ length: 35 }, (_, i) => `code ${i}`);
	const vectors = await embedTexts(CONFIG, texts, fakeEmbedFetch(calls) as typeof fetch);
	assert.equal(calls.length, 3); // 16 + 16 + 3
	assert.equal(String(calls[0].url), "http://localhost:8200/v1/embeddings");
	assert.equal((calls[0].body as { model?: string }).model, "bge-m3-mlx-8bit");
	assert.equal(vectors.length, 35);
	assert.deepEqual(vectors[0], [1, 1]); // first item of first batch, despite reversed response
});

test("embedTexts throws on http error", async () => {
	const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
	await assert.rejects(embedTexts(CONFIG, ["x"], failing));
});

// ── rankSuspects

function indexWith(entries: Array<{ name: string; filePath: string; vector: number[] }>): EmbeddingIndex {
	return {
		model: "bge-m3-mlx-8bit",
		builtAt: "2026-07-06T00:00:00.000Z",
		entries: entries.map((e) => ({ ...e, kind: "function", startLine: 5 })),
	};
}

/** 29 background entries at cosine ~0.70 vs [1,0], plus one configurable head. */
function backgroundEntries(): Array<{ name: string; filePath: string; vector: number[] }> {
	return Array.from({ length: 29 }, (_, i) => ({
		name: `bg${i}`,
		filePath: `src/bg${i}.ts`,
		vector: [0.7, Math.sqrt(1 - 0.49)],
	}));
}

test("rankSuspects flags a clear outlier as an embedding suspect", () => {
	const index = indexWith([{ name: "existingTwin", filePath: "src/twin.ts", vector: [0.999, 0.0447] }, ...backgroundEntries()]);
	const suspects = rankSuspects([1, 0], index, "src/new.ts", "freshFn");
	assert.equal(suspects.length, 1);
	assert.equal(suspects[0].match.name, "existingTwin");
	assert.equal(suspects[0].via, "embedding");
	assert.ok(suspects[0].score >= EMBED_SCORE_FLOOR);
});

test("rankSuspects excludes same-file entries and near-cone scores", () => {
	// twin sits in the edited file itself → excluded; best remaining is background cone
	const index = indexWith([{ name: "selfTwin", filePath: "src/new.ts", vector: [0.999, 0.0447] }, ...backgroundEntries()]);
	assert.deepEqual(rankSuspects([1, 0], index, "src/new.ts", "freshFn"), []);
});

test("rankSuspects returns [] on a too-small index", () => {
	const index = indexWith([{ name: "onlyOne", filePath: "src/x.ts", vector: [1, 0] }]);
	assert.deepEqual(rankSuspects([1, 0], index, "src/new.ts", "freshFn"), []);
});

// ── buildEmbeddingIndex

test("buildEmbeddingIndex embeds symbol bodies, skipping unreadable and tiny ones", async () => {
	const spans = [
		{ name: "alpha", kind: "function", filePath: "src/a.ts", startLine: 1, endLine: 9 },
		{ name: "tiny", kind: "function", filePath: "src/t.ts", startLine: 1, endLine: 2 },
		{ name: "gone", kind: "function", filePath: "src/g.ts", startLine: 1, endLine: 9 },
	];
	const bodies = new Map([
		["alpha", "export function alpha() {\n\treturn wireTogether(parseInput(), renderOutput());\n}"],
		["tiny", "x"],
	]);
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const index = await buildEmbeddingIndex(
		CONFIG,
		spans,
		(span) => bodies.get(span.name),
		fakeEmbedFetch(calls) as typeof fetch,
	);
	assert.equal(index.model, "bge-m3-mlx-8bit");
	assert.equal(index.entries.length, 1);
	assert.equal(index.entries[0].name, "alpha");
	assert.equal(index.entries[0].filePath, "src/a.ts");
	assert.equal(index.entries[0].vector.length, 2);
});
