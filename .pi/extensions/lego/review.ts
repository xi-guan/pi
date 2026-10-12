/**
 * Hook 3b — brick review (soft gate).
 *
 * Pure logic for the LLM-judged review of newly added bricks: prompt
 * construction, verdict parsing, and tool-result rewriting. The actual LLM
 * call lives in index.ts (needs pi runtime auth). Fails open: anything
 * unparseable counts as PASS so a flaky judge never blocks edits.
 */

export interface Verdict {
	pass: boolean;
	reason?: string;
}

interface TextBlock {
	type: "text";
	text?: string;
	[key: string]: unknown;
}

const VERDICT_RE = /LEGO_REVIEW:\s*(PASS|FAIL)\s*(?:[—-]\s*(.*))?/i;

export function parseVerdict(text: string): Verdict {
	const match = text.match(VERDICT_RE);
	if (!match) return { pass: true, reason: undefined };
	const pass = match[1].toUpperCase() === "PASS";
	const reason = match[2]?.trim();
	return { pass, reason: pass ? undefined : reason || "unspecified" };
}

/**
 * On FAIL, return the tool-result content with a rewrite instruction appended.
 * On PASS, return undefined (leave the result untouched).
 */
export function applyVerdict<T extends TextBlock>(content: T[], verdict: Verdict): T[] | undefined {
	if (verdict.pass) return undefined;
	const warning = [
		`⚠ lego brick review: FAIL — ${verdict.reason ?? "unspecified"}`,
		"Rewrite this brick before proceeding: fix the noted granularity/placement/interface/conventions issue, then re-apply the edit.",
	].join("\n");
	return [...content, { type: "text", text: warning } as T];
}

export function buildReviewPrompt(
	newSymbols: string[],
	diff: string,
	neighborLines: string[],
	suspectLines: string[] = [],
	noteLines: string[] = [],
): string {
	const criteria = [
		"1. granularity — single responsibility, reasonable size, not a god function",
		"2. placement — right file/layer given where the neighbor bricks live",
		"3. interface — parameter/return shapes consistent and minimal, name says what it does",
		"4. conventions — matches the idioms visible in the diff context and neighbors",
	];
	if (suspectLines.length > 0) {
		criteria.push(
			"5. duplication — deterministic recall flagged the suspects below; if the new symbol re-implements one of them, FAIL and name the symbol to reuse",
		);
	}
	if (noteLines.length > 0) {
		criteria.push(
			`${criteria.length + 1}. previously rejected approach — the records below were measured and rejected; if this change re-attempts one, FAIL and cite the record`,
		);
	}
	return [
		"You are a strict code reviewer judging whether newly added symbols are well-shaped bricks for this codebase.",
		"",
		`New symbols: ${newSymbols.join(", ")}`,
		"",
		"Change:",
		"```",
		diff,
		"```",
		neighborLines.length > 0 ? ["Existing neighbor bricks for comparison:", ...neighborLines, ""].join("\n") : "",
		suspectLines.length > 0 ? ["Suspected semantic duplicates:", ...suspectLines, ""].join("\n") : "",
		noteLines.length > 0 ? ["Previously rejected approaches (.pi/lego-notes):", ...noteLines, ""].join("\n") : "",
		`Judge ONLY these ${criteria.length} criteria:`,
		...criteria,
		"",
		"Reply with brief reasoning (max 3 lines), then exactly one final line:",
		"LEGO_REVIEW: PASS",
		"or",
		"LEGO_REVIEW: FAIL — <one-line actionable reason>",
	].join("\n");
}
