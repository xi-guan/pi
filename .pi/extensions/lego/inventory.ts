/**
 * Hooks 1 + 2 — brick inventory injection and plan gate.
 *
 * Pure logic: pull identifier-like keywords out of the user prompt, turn
 * codegraph results into a compact brick list message, and provide the
 * REUSE/EXTEND/NEW plan-gate rules appended to the system prompt.
 */
import type { CgSymbol } from "./codegraph.ts";

/** Common words that never make useful codegraph queries. */
const STOPWORDS = new Set([
	"about",
	"above",
	"after",
	"again",
	"before",
	"below",
	"between",
	"class",
	"could",
	"create",
	"delete",
	"error",
	"every",
	"first",
	"function",
	"implement",
	"instead",
	"lines",
	"method",
	"module",
	"number",
	"other",
	"please",
	"refactor",
	"remove",
	"rename",
	"return",
	"returns",
	"should",
	"string",
	"their",
	"there",
	"these",
	"thing",
	"those",
	"update",
	"using",
	"value",
	"where",
	"which",
	"while",
	"would",
	"write",
]);

const FILE_RE = /([\w.-]+)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|swift)\b/g;
const WORD_RE = /\b[A-Za-z_$][\w$]*\b/g;
const PLAIN_WORD_RE = /\b[a-zA-Z]{5,}\b/g;

/** Extract identifier-like keywords from a user prompt, capped. */
export function extractKeywords(prompt: string, cap = 8): string[] {
	const seen = new Set<string>();
	const keywords: string[] = [];
	const push = (token: string) => {
		const key = token.toLowerCase();
		if (!seen.has(key) && keywords.length < cap) {
			seen.add(key);
			keywords.push(token);
		}
	};

	for (const match of prompt.matchAll(FILE_RE)) push(match[1]);
	for (const match of prompt.matchAll(WORD_RE)) {
		const token = match[0];
		const identifierLike = /[a-z][A-Z]/.test(token) || token.includes("_") || /^[A-Z]{2,6}$/.test(token);
		if (identifierLike && !STOPWORDS.has(token.toLowerCase())) push(token);
	}
	if (keywords.length < 3) {
		for (const match of prompt.matchAll(PLAIN_WORD_RE)) {
			const token = match[0];
			if (!STOPWORDS.has(token.toLowerCase())) push(token);
		}
	}
	return keywords;
}

/** Merge per-keyword query results: dedupe by identity, cap total size. */
export function buildInventory(symbolLists: CgSymbol[][], cap = 30): CgSymbol[] {
	const seen = new Map<string, CgSymbol>();
	for (const list of symbolLists) {
		for (const symbol of list) {
			const key = `${symbol.filePath}:${symbol.startLine}:${symbol.name}`;
			if (!seen.has(key)) seen.set(key, symbol);
			if (seen.size >= cap) return [...seen.values()];
		}
	}
	return [...seen.values()];
}

/** Render the brick list injected as a custom context message. */
export function formatInventory(symbols: CgSymbol[]): string {
	const lines = symbols.map(
		(s) =>
			`- ${s.name} (${s.kind}) — ${s.filePath}:${s.startLine}${s.signature ? ` — ${s.signature}` : ""}`,
	);
	return [
		"Existing bricks possibly relevant to this task. REUSE or EXTEND these before writing new code:",
		...lines,
	].join("\n");
}

/** Appended to the system prompt each turn (hook 2). */
export const PLAN_GATE_RULES = [
	"",
	"## Lego plan gate (reuse-first)",
	"Before any code edits, produce a brick plan: one line per planned change, tagged [REUSE], [EXTEND], or [NEW].",
	"- [REUSE] name the existing symbol you will call.",
	"- [EXTEND] name the existing symbol you will modify and how.",
	"- [NEW] requires a one-line justification: why no existing brick fits (name the closest candidate you rejected).",
	"Do not start editing before the tagged plan. Near-duplicate new symbols are blocked by the dedup gate; prefer wiring existing bricks together.",
].join("\n");
