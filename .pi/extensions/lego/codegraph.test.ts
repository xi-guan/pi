import assert from "node:assert/strict";
import { test } from "node:test";
import { Codegraph, indexPath, projectSlug } from "./codegraph.ts";
import { FIXTURE_CWD, FIXTURE_PROJECT, makeIndexDb } from "./fixtures.ts";

const SIGNATURE_PROPS = { signature: "(text: string)", return_type: ": string", is_exported: true };

const SYMBOLS = [
	{ id: 1, label: "Function", name: "normalizeToLF", filePath: "src/core/edit-diff.ts", properties: SIGNATURE_PROPS },
	{ id: 2, label: "Module", name: "./edit-diff.ts", filePath: "src/core/edit.ts" },
	{ id: 3, label: "Function", name: "collectRunData", filePath: "src/verify.ts" },
	{ id: 4, label: "Function", name: "resolveTimeout", filePath: "src/a.ts" },
	{ id: 5, label: "Method", name: "has", filePath: "src/b.ts" },
	{ id: 6, label: "Interface", name: "RunData", filePath: "src/c.ts" },
	{ id: 7, label: "Function", name: "normalizeToLF", filePath: "src/unindexed.ts", project: `${FIXTURE_PROJECT}::missed` },
];
const CALLS: Array<[number, number]> = [
	[3, 4],
	[3, 5],
	[3, 6],
];

const withFixture = () => new Codegraph(() => FIXTURE_CWD, () => makeIndexDb(SYMBOLS, CALLS));

test("query parses symbols and filters non-symbol labels", async () => {
	const symbols = await withFixture().query("normalize");
	assert.equal(symbols.length, 1);
	assert.equal(symbols[0].name, "normalizeToLF");
	assert.equal(symbols[0].kind, "function");
	assert.equal(symbols[0].startLine, 18);
	assert.equal(symbols[0].signature, "(text: string): string");
	assert.equal(symbols[0].isExported, true);
});

test("query matches a camelCase fragment and honours the limit", async () => {
	assert.equal((await withFixture().query("LF")).length, 1);
	assert.equal((await withFixture().query("normalizeToLF", 0)).length, 0);
});

test("query excludes the ::missed companion project", async () => {
	const hits = await withFixture().query("normalize");
	assert.deepEqual(
		hits.map((s) => s.filePath),
		["src/core/edit-diff.ts"],
	);
});

test("query returns [] when the index is absent", async () => {
	const cg = new Codegraph(() => "/nope", () => undefined);
	assert.deepEqual(await cg.query("anything"), []);
	assert.equal(await cg.available(), false);
});

test("query returns [] when a term breaks FTS syntax", async () => {
	assert.deepEqual(await withFixture().query('bad" OR "x'), []);
});

test("callees returns called function/method names, dropping type references", async () => {
	assert.deepEqual(await withFixture().callees("collectRunData"), ["resolveTimeout", "has"]);
});

test("callees returns [] for an unknown symbol or a missing index", async () => {
	assert.deepEqual(await withFixture().callees("nosuch"), []);
	assert.deepEqual(await new Codegraph(() => "/nope", () => undefined).callees("x"), []);
});

test("the index is opened once per project and reopened when cwd changes", async () => {
	let opens = 0;
	let cwd = FIXTURE_CWD;
	const cg = new Codegraph(
		() => cwd,
		() => {
			opens++;
			return makeIndexDb(SYMBOLS, CALLS);
		},
	);
	await cg.query("normalize");
	await cg.query("collect");
	assert.equal(opens, 1);
	cwd = "/other-root";
	await cg.query("normalize");
	assert.equal(opens, 2);
});

test("projectSlug and indexPath mirror the codebase-memory-mcp layout", () => {
	assert.equal(projectSlug("/Users/xig/coaster/oss/pi"), "Users-xig-coaster-oss-pi");
	assert.equal(projectSlug("/Users/xig/coaster/oss/pi/"), "Users-xig-coaster-oss-pi");
	assert.equal(projectSlug("C:\\dev\\pi"), "C:-dev-pi");
	assert.match(indexPath("/Users/xig/coaster/oss/pi"), /\.cache\/codebase-memory-mcp\/Users-xig-coaster-oss-pi\.db$/);
});
