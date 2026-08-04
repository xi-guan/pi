import assert from "node:assert/strict";
import { test } from "node:test";
import type { CgSymbol } from "./codegraph.ts";
import { buildInventory, extractKeywords, formatInventory, PLAN_GATE_RULES } from "./inventory.ts";

// ── extractKeywords

test("extracts identifiers, file basenames, and short acronyms", () => {
	const keywords = extractKeywords("Fix retryWithBackoff in AuthService and session-manager.ts to handle CRLF");
	assert.ok(keywords.includes("retryWithBackoff"));
	assert.ok(keywords.includes("AuthService"));
	assert.ok(keywords.includes("session-manager"));
	assert.ok(keywords.includes("CRLF"));
});

test("falls back to plain words when no identifiers present", () => {
	const keywords = extractKeywords("convert carriage returns at line endings");
	assert.ok(keywords.length > 0);
	assert.ok(keywords.includes("carriage"));
});

test("caps keyword count and dedupes case-insensitively", () => {
	const prompt = Array.from({ length: 12 }, (_, i) => `doThing${i}Now`).join(" ") + " authService AuthService";
	const keywords = extractKeywords(prompt);
	assert.ok(keywords.length <= 8);
	assert.equal(keywords.filter((k) => k.toLowerCase() === "authservice").length, 0); // beyond cap or deduped
});

test("returns [] for empty prompt", () => {
	assert.deepEqual(extractKeywords(""), []);
});

// ── buildInventory / formatInventory

function sym(name: string, filePath = "src/a.ts", startLine = 1): CgSymbol {
	return { name, kind: "function", filePath, startLine, signature: "(x: string): string" };
}

test("buildInventory dedupes across keyword result lists and caps", () => {
	const lists = [
		[sym("alpha"), sym("beta")],
		[sym("alpha"), sym("gamma")],
	];
	const inventory = buildInventory(lists, 30);
	assert.deepEqual(
		inventory.map((s) => s.name),
		["alpha", "beta", "gamma"],
	);
	const many = [Array.from({ length: 40 }, (_, i) => sym(`fn${i}`, `src/f${i}.ts`))];
	assert.equal(buildInventory(many, 30).length, 30);
});

test("formatInventory lists name, kind, location, signature under a REUSE header", () => {
	const text = formatInventory([sym("normalizeToLF", "packages/core/edit-diff.ts", 18)]);
	assert.match(text, /REUSE/);
	assert.match(text, /normalizeToLF \(function\)/);
	assert.match(text, /packages\/core\/edit-diff\.ts:18/);
	assert.match(text, /\(x: string\): string/);
});

// ── plan gate rules

test("plan gate rules demand tags and NEW justification", () => {
	assert.match(PLAN_GATE_RULES, /\[REUSE\]/);
	assert.match(PLAN_GATE_RULES, /\[EXTEND\]/);
	assert.match(PLAN_GATE_RULES, /\[NEW\]/);
	assert.match(PLAN_GATE_RULES, /justification/i);
});
