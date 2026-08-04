import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateStats, collectRunData, countReusedCalls, extractCallNames } from "./verify.ts";

function assistantWithToolCalls(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", ...c })),
	};
}

function toolResult(toolCallId: string, toolName: string, isError = false) {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError };
}

// ── collectRunData

test("collects added text from successful edit/write calls, skipping blocked ones", () => {
	const messages = [
		assistantWithToolCalls([
			{ id: "t1", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "x", newText: "callAlpha();" }] } },
			{ id: "t2", name: "write", arguments: { path: "b.ts", content: "export function fresh() { callBeta(); }" } },
			{ id: "t3", name: "write", arguments: { path: "c.ts", content: "callGamma();" } },
			{ id: "t4", name: "bash", arguments: { command: "ls" } },
		]),
		toolResult("t1", "edit"),
		toolResult("t2", "write"),
		toolResult("t3", "write", true), // blocked/errored — must not count
	];
	const data = collectRunData(messages as never);
	assert.equal(data.editCount, 2);
	assert.match(data.addedText, /callAlpha/);
	assert.match(data.addedText, /callBeta/);
	assert.ok(!data.addedText.includes("callGamma"));
});

// ── extractCallNames

test("extracts call names, excluding keywords, builtins, and self-declared names", () => {
	const code = [
		"export function fresh() {",
		"\tif (ready) {",
		"\t\tconst rows = parseRows(input);",
		"\t\treturn JSON.stringify(rows.map(toRecord));",
		"\t}",
		"\tfresh();", // self-declared above
		"}",
	].join("\n");
	const names = extractCallNames(code);
	assert.ok(names.includes("parseRows"));
	assert.ok(!names.includes("if"));
	assert.ok(!names.includes("stringify")); // JSON.stringify → member call of builtin
	assert.ok(!names.includes("JSON"));
	assert.ok(!names.includes("fresh"));
	assert.ok(!names.includes("map")); // member call, not a brick reuse
	assert.ok(!names.includes("toRecord")); // bare identifier argument is not a call
});

test("extracts inner names of nested calls", () => {
	const names = extractCallNames("return normalizeToLF(stripBom(raw).text);");
	assert.ok(names.includes("normalizeToLF"));
	assert.ok(names.includes("stripBom"));
});

// ── countReusedCalls

test("counts distinct calls that resolve to existing symbols", async () => {
	const existing = new Set(["parseRows", "renderTable"]);
	const count = await countReusedCalls(
		"parseRows(a); parseRows(b); renderTable(c); unknownFn(d);",
		async (name) => existing.has(name),
	);
	assert.equal(count, 2);
});

// ── aggregateStats

test("aggregates run stats shape", () => {
	const stats = aggregateStats({
		editCount: 3,
		newSymbols: ["fresh"],
		escapes: [{ name: "fresh", reason: "demo" }],
		blockedCount: 1,
		reviewFails: 1,
		reusedCalls: 4,
		missedDuplicates: ["fresh ≈ freshen (src/x.ts:3)"],
		semanticFlags: ["fresh ≈ freshen (src/x.ts:3) via embedding"],
	});
	assert.equal(stats.edits, 3);
	assert.deepEqual(stats.newSymbols, ["fresh"]);
	assert.equal(stats.blocked, 1);
	assert.equal(stats.reviewFails, 1);
	assert.equal(stats.reusedCalls, 4);
	assert.equal(stats.missedDuplicates.length, 1);
	assert.equal(stats.escapes[0].reason, "demo");
	assert.deepEqual(stats.semanticFlags, ["fresh ≈ freshen (src/x.ts:3) via embedding"]);
});
