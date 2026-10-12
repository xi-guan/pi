import assert from "node:assert/strict";
import { test } from "node:test";
import { applyVerdict, buildReviewPrompt, parseVerdict } from "./review.ts";

// ── parseVerdict

test("parses PASS and FAIL verdicts (em-dash or hyphen, any case)", () => {
	assert.deepEqual(parseVerdict("...analysis...\nLEGO_REVIEW: PASS"), { pass: true, reason: undefined });
	assert.deepEqual(parseVerdict("LEGO_REVIEW: FAIL — function does three unrelated things"), {
		pass: false,
		reason: "function does three unrelated things",
	});
	assert.deepEqual(parseVerdict("lego_review: fail - wrong layer"), { pass: false, reason: "wrong layer" });
});

test("defaults to PASS on garbled output (soft gate fails open)", () => {
	assert.equal(parseVerdict("I think this is mostly fine?").pass, true);
	assert.equal(parseVerdict("").pass, true);
});

// ── applyVerdict

test("appends rewrite instruction on FAIL, leaves content untouched on PASS", () => {
	const content = [{ type: "text" as const, text: "File edited." }];
	assert.equal(applyVerdict(content, { pass: true }), undefined);
	const rewritten = applyVerdict(content, { pass: false, reason: "god function in wrong layer" });
	assert.ok(rewritten);
	assert.equal(rewritten.length, 2);
	assert.equal(rewritten[0].text, "File edited.");
	assert.match(rewritten[1].text ?? "", /brick review: FAIL/);
	assert.match(rewritten[1].text ?? "", /god function in wrong layer/);
	assert.match(rewritten[1].text ?? "", /[Rr]ewrite/);
});

// ── buildReviewPrompt

test("review prompt names the bricks, includes diff and criteria, demands verdict line", () => {
	const prompt = buildReviewPrompt(
		["retryWithJitter"],
		"+export function retryWithJitter() {}",
		["- withRetry (function) — src/retry.ts:10"],
	);
	assert.match(prompt, /retryWithJitter/);
	assert.match(prompt, /\+export function retryWithJitter/);
	assert.match(prompt, /withRetry/);
	for (const criterion of ["granularity", "placement", "interface", "conventions"]) {
		assert.match(prompt, new RegExp(criterion, "i"));
	}
	assert.match(prompt, /LEGO_REVIEW: PASS/);
	assert.match(prompt, /LEGO_REVIEW: FAIL/);
});

test("review prompt lists semantic suspects and adds the duplication criterion", () => {
	const prompt = buildReviewPrompt(
		["assembleReport"],
		"+export function assembleReport() {}",
		[],
		["- assembleReport ≈ buildReportHtml (src/report.ts:10) via callees — shared calls: sanitizeCells, renderTable"],
	);
	assert.match(prompt, /Suspected semantic duplicates/);
	assert.match(prompt, /buildReportHtml/);
	assert.match(prompt, /duplication/i);
	assert.match(prompt, /name the symbol to reuse/i);
});

test("review prompt omits the duplication criterion without suspects", () => {
	const prompt = buildReviewPrompt(["x"], "+x", []);
	assert.ok(!prompt.includes("Suspected semantic duplicates"));
	assert.ok(!/duplication/i.test(prompt));
});

test("review prompt lists matched records and adds the rejected-approach criterion", () => {
	const noteLines = ["- soft-bounce-has-no-force — hard blocks change behavior, soft bounces do not"];
	const prompt = buildReviewPrompt(["rankSuspects"], "+export function rankSuspects() {}", [], [], noteLines);
	assert.match(prompt, /Previously rejected approaches \(\.pi\/lego-notes\)/);
	assert.match(prompt, /soft-bounce-has-no-force/);
	assert.match(prompt, /5\. previously rejected approach/);
	assert.match(prompt, /cite the record/i);
});

test("rejected-approach criterion is numbered after duplication when both fire", () => {
	const prompt = buildReviewPrompt(["x"], "+x", [], ["- x ≈ y (a.ts:1) via callees"], ["- n — s"]);
	assert.match(prompt, /5\. duplication/);
	assert.match(prompt, /6\. previously rejected approach/);
	assert.match(prompt, /Judge ONLY these 6 criteria/);
});

test("review prompt omits the rejected-approach criterion without records", () => {
	const prompt = buildReviewPrompt(["x"], "+x", []);
	assert.ok(!prompt.includes("Previously rejected approaches"));
	assert.ok(!/previously rejected approach/i.test(prompt));
});
