import assert from "node:assert/strict";
import { test } from "node:test";
import { Codegraph } from "./codegraph.ts";
import { FIXTURE_CWD, type FixtureSymbol, makeIndexDb } from "./fixtures.ts";
import {
	buildCandidateTerms,
	collectNewDeclarations,
	evaluateToolCall,
	extractDeclarations,
	nameSimilarity,
	SIMILARITY_THRESHOLD,
	tokenizeName,
} from "./dedup.ts";

// ── extractDeclarations

test("extracts TS/JS declaration kinds", () => {
	const code = [
		"export async function fetchUserProfile(id: string): Promise<Profile> {",
		"class RetryQueue {",
		"export interface CacheEntry {",
		"type ModelKey = string;",
		"export const parseHeaders = (raw: string) => {",
		"enum Color {",
		"\tprivate async flushPending(): Promise<void> {",
	].join("\n");
	const names = extractDeclarations(code).map((d) => `${d.kind}:${d.name}`);
	assert.deepEqual(names, [
		"function:fetchUserProfile",
		"class:RetryQueue",
		"interface:CacheEntry",
		"type:ModelKey",
		"function:parseHeaders",
		"enum:Color",
		"method:flushPending",
	]);
});

test("ignores control flow, calls, callbacks, and plain consts", () => {
	const code = [
		"if (foo) {",
		"for (const x of xs) {",
		"while (running) {",
		"} catch (err) {",
		"switch (kind) {",
		'describe("suite", function () {',
		"withQueue(path, async () => {",
		"callThing(arg1, arg2);",
		"constructor(options: Options) {",
		"const MAX_RETRIES = 3;",
		"return foo(bar);",
	].join("\n");
	assert.deepEqual(extractDeclarations(code), []);
});

test("captures lego:new escape hatch on same line or line above", () => {
	const code = [
		"// lego:new(no existing retry primitive fits)",
		"export function retryWithJitter() {",
		"function plainNew() {",
		"const quickParse = (s: string) => { // lego:new(one-off format)",
	].join("\n");
	const decls = extractDeclarations(code);
	assert.equal(decls[0].name, "retryWithJitter");
	assert.equal(decls[0].escapeReason, "no existing retry primitive fits");
	assert.equal(decls[1].name, "plainNew");
	assert.equal(decls[1].escapeReason, undefined);
	assert.equal(decls[2].name, "quickParse");
	assert.equal(decls[2].escapeReason, "one-off format");
});

test("captures signature and doc comment block above a declaration", () => {
	const code = [
		"// strips the BOM marker",
		"// before hashing the payload",
		"export function cleanPayload(buf: RawBuffer): RawBuffer {",
		"",
		"// lego:new(escape reasons are not docs)",
		"function standalone() {",
	].join("\n");
	const decls = extractDeclarations(code);
	assert.match(decls[0].signature ?? "", /buf: RawBuffer/);
	assert.match(decls[0].doc ?? "", /BOM marker/);
	assert.match(decls[0].doc ?? "", /hashing the payload/);
	assert.equal(decls[1].doc, undefined);
});

test("buildCandidateTerms adds signature types and doc words, skipping primitives", () => {
	const terms = buildCandidateTerms({
		name: "cleanText",
		kind: "function",
		line: 1,
		signature: "(raw: string, opts: ParseOpts): NormalizedText",
		doc: "Strip BOM then convert CRLF to LF.",
	});
	assert.ok(terms.includes("cleanText"));
	assert.ok(terms.includes("clean"));
	assert.ok(terms.includes("text"));
	assert.ok(terms.includes("ParseOpts"));
	assert.ok(terms.includes("NormalizedText"));
	assert.ok(terms.some((t) => ["strip", "convert", "crlf"].includes(t.toLowerCase())));
	assert.ok(!terms.some((t) => t.toLowerCase() === "string"));
	assert.ok(terms.length <= 8);
});

// ── similarity

test("tokenizes camelCase, PascalCase, snake_case, acronyms", () => {
	assert.deepEqual(tokenizeName("normalizeToLF"), ["normalize", "to", "lf"]);
	assert.deepEqual(tokenizeName("HTTPClient"), ["http", "client"]);
	assert.deepEqual(tokenizeName("snake_case_name"), ["snake", "case", "name"]);
});

test("name similarity separates near-duplicates from unrelated names", () => {
	assert.equal(nameSimilarity("normalizeToLF", "normalizeToLF"), 1);
	assert.ok(nameSimilarity("normalizeCrlfToLf", "normalizeToLF") >= SIMILARITY_THRESHOLD);
	assert.equal(nameSimilarity("HttpClient", "HTTPClient"), 1);
	assert.ok(nameSimilarity("parseFoo", "renderBar") < 0.3);
});

// ── collectNewDeclarations

test("collects from write content", () => {
	const { path, decls } = collectNewDeclarations("write", {
		path: "src/util.ts",
		content: "export function convertCrlf(s: string) {\n}",
	});
	assert.equal(path, "src/util.ts");
	assert.deepEqual(
		decls.map((d) => d.name),
		["convertCrlf"],
	);
});

test("collects from edits[], skipping names already declared in oldText", () => {
	const { decls } = collectNewDeclarations("edit", {
		path: "src/util.ts",
		edits: [
			{
				oldText: "function existing(a) {\n\treturn a;\n}",
				newText: "function existing(a, b) {\n\treturn a + b;\n}\nfunction brandNew() {\n}",
			},
		],
	});
	assert.deepEqual(
		decls.map((d) => d.name),
		["brandNew"],
	);
});

test("collects from legacy single oldText/newText edit shape", () => {
	const { decls } = collectNewDeclarations("edit", {
		path: "src/util.ts",
		oldText: "const a = 1;",
		newText: "const a = 1;\nexport function freshHelper() {}",
	});
	assert.deepEqual(
		decls.map((d) => d.name),
		["freshHelper"],
	);
});

// ── evaluateToolCall (with fake codegraph)

const NORMALIZE_HIT = [
	{
		id: 1,
		label: "Function",
		name: "normalizeToLF",
		filePath: "packages/coding-agent/src/core/tools/edit-diff.ts",
		properties: { signature: "(text: string)", return_type: ": string", is_exported: true },
	},
];

function fakeCodegraph(symbols: FixtureSymbol[]): Codegraph {
	return new Codegraph(() => FIXTURE_CWD, () => makeIndexDb(symbols));
}

test("blocks a near-duplicate new symbol in another file", async () => {
	const cg = fakeCodegraph(NORMALIZE_HIT);
	const result = await evaluateToolCall(
		"write",
		{ path: "src/new-util.ts", content: "export function normalizeCrlfToLf(s: string) {\n}" },
		cg,
	);
	assert.ok(result);
	assert.equal(result.hits.length, 1);
	assert.equal(result.hits[0].match.name, "normalizeToLF");
	assert.ok(result.reason);
	assert.match(result.reason, /normalizeToLF/);
	assert.match(result.reason, /edit-diff\.ts:18/);
	assert.match(result.reason, /lego:new/);
});

test("does not block when the only match is the same file", async () => {
	const cg = fakeCodegraph(NORMALIZE_HIT);
	const result = await evaluateToolCall(
		"edit",
		{
			path: "packages/coding-agent/src/core/tools/edit-diff.ts",
			edits: [{ oldText: "// x", newText: "// x\nexport function normalizeCrlfToLf(s: string) {}" }],
		},
		cg,
	);
	assert.ok(result);
	assert.equal(result.hits.length, 0);
	assert.equal(result.reason, undefined);
});

test("escape hatch lets a duplicate through but records it", async () => {
	const cg = fakeCodegraph(NORMALIZE_HIT);
	const result = await evaluateToolCall(
		"write",
		{
			path: "src/new-util.ts",
			content: "// lego:new(demo escape)\nexport function normalizeCrlfToLf(s: string) {\n}",
		},
		cg,
	);
	assert.ok(result);
	assert.equal(result.hits.length, 0);
	assert.equal(result.escaped.length, 1);
	assert.equal(result.escaped[0].escapeReason, "demo escape");
});

test("exposes the recalled candidate pool for downstream semantic checks", async () => {
	const cg = fakeCodegraph(NORMALIZE_HIT);
	const result = await evaluateToolCall(
		"write",
		{ path: "src/new-util.ts", content: "// lego:new(demo)\nexport function normalizeCrlfToLf(s: string) {\n}" },
		cg,
	);
	assert.ok(result);
	assert.equal(result.candidates.length, 1);
	assert.equal(result.candidates[0].name, "normalizeToLF");
});

test("returns undefined for non-edit tools and when nothing is declared", async () => {
	const cg = fakeCodegraph([]);
	assert.equal(await evaluateToolCall("bash", { command: "ls" }, cg), undefined);
	assert.equal(await evaluateToolCall("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, cg), undefined);
});
