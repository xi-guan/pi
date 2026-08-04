import assert from "node:assert/strict";
import { test } from "node:test";
import type { CgSymbol } from "./codegraph.ts";
import { findCalleeSuspects, formatSuspects, jaccard } from "./semantic.ts";

function candidate(name: string, filePath = "src/existing.ts"): CgSymbol {
	return { name, kind: "function", filePath, startLine: 10 };
}

// ── jaccard

test("jaccard measures set overlap", () => {
	assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
	assert.equal(jaccard(new Set(["a", "b", "c", "d"]), new Set(["a", "b", "e", "f"])), 2 / 6);
	assert.equal(jaccard(new Set(), new Set(["a"])), 0);
});

// ── findCalleeSuspects

const NEW_CODE = [
	"export function assembleReport(rows: Row[]): string {",
	"\tconst clean = sanitizeCells(rows);",
	"\tconst table = renderTable(clean);",
	"\treturn wrapDocument(table);",
	"}",
].join("\n");

test("flags a candidate whose callee set overlaps the new function's calls", async () => {
	const calleesByName = new Map([["buildReportHtml", ["sanitizeCells", "renderTable", "wrapDocument"]]]);
	const suspects = await findCalleeSuspects(
		NEW_CODE,
		[{ name: "assembleReport", kind: "function", line: 1 }],
		[candidate("buildReportHtml")],
		"src/new-report.ts",
		async (name) => calleesByName.get(name) ?? [],
	);
	assert.equal(suspects.length, 1);
	assert.equal(suspects[0].match.name, "buildReportHtml");
	assert.equal(suspects[0].via, "callees");
	assert.ok(suspects[0].score >= 0.5);
	assert.match(suspects[0].detail ?? "", /sanitizeCells/);
});

test("skips same-file candidates and low-overlap candidates", async () => {
	const calleesByName = new Map([
		["sameFileTwin", ["sanitizeCells", "renderTable", "wrapDocument"]],
		["barelyRelated", ["sanitizeCells", "openSocket", "sendMail", "closeSocket"]],
	]);
	const suspects = await findCalleeSuspects(
		NEW_CODE,
		[{ name: "assembleReport", kind: "function", line: 1 }],
		[candidate("sameFileTwin", "src/new-report.ts"), candidate("barelyRelated")],
		"src/new-report.ts",
		async (name) => calleesByName.get(name) ?? [],
	);
	assert.deepEqual(suspects, []);
});

test("formatSuspects renders decl, match location, signal, and detail", () => {
	const lines = formatSuspects([
		{
			declName: "assembleReport",
			match: candidate("buildReportHtml", "src/report.ts"),
			via: "callees",
			score: 0.75,
			detail: "shared calls: sanitizeCells, renderTable",
		},
	]);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /assembleReport ≈ buildReportHtml \(src\/report\.ts:10\)/);
	assert.match(lines[0], /via callees/);
	assert.match(lines[0], /shared calls: sanitizeCells, renderTable/);
});

test("returns [] when the new code has fewer than two bare calls", async () => {
	const suspects = await findCalleeSuspects(
		"export function leaf(s: string) { return s.replace(/a/g, 'b'); }",
		[{ name: "leaf", kind: "function", line: 1 }],
		[candidate("anything")],
		"src/leaf.ts",
		async () => ["sanitizeCells", "renderTable"],
	);
	assert.deepEqual(suspects, []);
});
