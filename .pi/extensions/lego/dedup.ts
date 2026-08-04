/**
 * Hook 3a — duplicate-symbol hard block.
 *
 * Pure logic: extract newly declared symbols from edit/write tool input,
 * compare their names against existing codegraph symbols (token dice
 * similarity, no embeddings in v1), and produce a block decision.
 *
 * Escape hatch: a `lego:new(<reason>)` comment on the declaration line or the
 * line above lets the symbol through; the reason is kept for metrics.
 */
import type { CgSymbol, Codegraph } from "./codegraph.ts";

export interface Decl {
	name: string;
	kind: string;
	line: number;
	escapeReason?: string;
	/** Declaration-line remainder after the name (params/return type). */
	signature?: string;
	/** Contiguous comment block directly above the declaration. */
	doc?: string;
}

export interface DupHit {
	decl: Decl;
	match: CgSymbol;
	score: number;
}

export interface DedupResult {
	/** Path of the edited/written file. */
	path: string;
	/** All newly declared symbols in this tool call (including escaped ones). */
	newSymbols: Decl[];
	/** Symbols carrying a lego:new(...) escape comment. */
	escaped: Decl[];
	/** Blocking near-duplicate matches (empty when the call may proceed). */
	hits: DupHit[];
	/** Recalled existing symbols, reused by semantic checks downstream (3b). */
	candidates: CgSymbol[];
	/** Formatted block reason when hits is non-empty. */
	reason?: string;
}

export const SIMILARITY_THRESHOLD = 0.8;

/** Names that look like declarations to the method regex but never are. */
const KEYWORD_BLOCKLIST = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"new",
	"typeof",
	"await",
	"else",
	"do",
	"try",
	"constructor",
	"function",
	"super",
	"this",
]);

const ESCAPE_RE = /lego:new\(([^)]*)\)/;

interface LinePattern {
	kind: string;
	re: RegExp;
}

const LINE_PATTERNS: LinePattern[] = [
	{ kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
	{ kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/ },
	{
		// const/let/var bound to a function value only; plain value consts are not bricks
		kind: "function",
		re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^=]*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function\b)/,
	},
];

const METHOD_RE =
	/^\s*(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^={;]+)?\s*\{\s*(?:\/\/.*)?$/;

/** Arg content that marks a call-with-callback rather than a parameter list. */
const METHOD_ARG_RED_FLAGS = /["'`]|=>|\bfunction\b/;

export function extractDeclarations(code: string): Decl[] {
	const lines = code.split("\n");
	const decls: Decl[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const decl = matchDeclaration(line);
		if (!decl) continue;

		const sameLine = line.match(ESCAPE_RE);
		const lineAbove = i > 0 ? lines[i - 1].match(ESCAPE_RE) : null;
		const escape = sameLine ?? lineAbove;
		const signature = extractSignature(line, decl.name);
		const doc = extractDocAbove(lines, i);
		decls.push({
			...decl,
			line: i + 1,
			...(escape ? { escapeReason: escape[1].trim() } : {}),
			...(signature ? { signature } : {}),
			...(doc ? { doc } : {}),
		});
	}

	return decls;
}

function extractSignature(line: string, name: string): string | undefined {
	const nameIndex = line.indexOf(name);
	if (nameIndex < 0) return undefined;
	const rest = line
		.slice(nameIndex + name.length)
		.replace(/\s*\{\s*(\/\/.*)?$/, "")
		.trim();
	return rest || undefined;
}

const COMMENT_LINE_RE = /^\s*(\/\/|\/\*\*?|\*\/|\*)/;

function extractDocAbove(lines: string[], declIndex: number): string | undefined {
	const parts: string[] = [];
	for (let i = declIndex - 1; i >= 0; i--) {
		const line = lines[i];
		if (!COMMENT_LINE_RE.test(line)) break;
		if (ESCAPE_RE.test(line)) continue; // escape hatch is not documentation
		const text = line.replace(/^\s*(\/\/|\/\*\*?|\*\/|\*)+\s?/, "").replace(/\*\/\s*$/, "").trim();
		if (text) parts.unshift(text);
	}
	const doc = parts.join(" ").trim();
	return doc || undefined;
}

function matchDeclaration(line: string): Pick<Decl, "name" | "kind"> | undefined {
	for (const pattern of LINE_PATTERNS) {
		const match = line.match(pattern.re);
		if (match) return { name: match[1], kind: pattern.kind };
	}

	const method = line.match(METHOD_RE);
	if (method && !KEYWORD_BLOCKLIST.has(method[1]) && !METHOD_ARG_RED_FLAGS.test(method[2])) {
		return { name: method[1], kind: "method" };
	}

	return undefined;
}

export function tokenizeName(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((token) => token.toLowerCase());
}

/** Dice coefficient over name token multisets: 1 = same tokens, 0 = disjoint. */
export function nameSimilarity(a: string, b: string): number {
	const tokensA = tokenizeName(a);
	const tokensB = tokenizeName(b);
	if (tokensA.length === 0 || tokensB.length === 0) return 0;

	const counts = new Map<string, number>();
	for (const token of tokensA) counts.set(token, (counts.get(token) ?? 0) + 1);
	let overlap = 0;
	for (const token of tokensB) {
		const count = counts.get(token) ?? 0;
		if (count > 0) {
			overlap++;
			counts.set(token, count - 1);
		}
	}
	return (2 * overlap) / (tokensA.length + tokensB.length);
}

/** Extract newly declared symbols from edit/write tool input (both edit shapes). */
export function collectNewDeclarations(
	toolName: string,
	input: Record<string, unknown>,
): { path: string; decls: Decl[] } {
	const path = typeof input.path === "string" ? input.path : "";

	if (toolName === "write") {
		const content = typeof input.content === "string" ? input.content : "";
		return { path, decls: extractDeclarations(content) };
	}

	const edits = Array.isArray(input.edits) ? input.edits : [{ oldText: input.oldText, newText: input.newText }];
	const decls: Decl[] = [];
	for (const edit of edits) {
		const record = (edit ?? {}) as Record<string, unknown>;
		const oldText = typeof record.oldText === "string" ? record.oldText : "";
		const newText = typeof record.newText === "string" ? record.newText : "";
		const existingNames = new Set(extractDeclarations(oldText).map((d) => d.name));
		for (const decl of extractDeclarations(newText)) {
			if (!existingNames.has(decl.name)) decls.push(decl);
		}
	}
	return { path, decls };
}

export function isSameFile(editedPath: string, symbolPath: string): boolean {
	const a = editedPath.replace(/\\/g, "/");
	const b = symbolPath.replace(/\\/g, "/");
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** TS primitives and connector words that make useless codegraph queries. */
const QUERY_NOISE = new Set([
	"string",
	"number",
	"boolean",
	"void",
	"undefined",
	"null",
	"any",
	"unknown",
	"never",
	"object",
	"symbol",
	"bigint",
	"promise",
	"array",
	"record",
	"partial",
	"readonly",
	"async",
	"export",
	"function",
	"const",
	"return",
	"returns",
	"this",
	"that",
	"then",
	"with",
	"from",
	"into",
	"when",
	"before",
	"after",
	"true",
	"false",
]);

/** Query terms for one declaration: name + name tokens + signature types + doc words. */
export function buildCandidateTerms(decl: Decl, cap = 8): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	const push = (term: string) => {
		const key = term.toLowerCase();
		if (term.length < 3 || seen.has(key) || QUERY_NOISE.has(key) || terms.length >= cap) return;
		seen.add(key);
		terms.push(term);
	};

	push(decl.name);
	for (const token of tokenizeName(decl.name)) push(token);
	for (const match of (decl.signature ?? "").matchAll(/[A-Za-z_$][\w$]*/g)) push(match[0]);
	for (const match of (decl.doc ?? "").matchAll(/[A-Za-z]{4,}/g)) push(match[0]);
	return terms;
}

async function findCandidates(decl: Decl, codegraph: Codegraph): Promise<CgSymbol[]> {
	const results = await Promise.all(buildCandidateTerms(decl).map((term) => codegraph.query(term, 10)));
	const seen = new Map<string, CgSymbol>();
	for (const symbols of results) {
		for (const symbol of symbols) {
			seen.set(`${symbol.filePath}:${symbol.startLine}:${symbol.name}`, symbol);
		}
	}
	return [...seen.values()];
}

export function formatBlockReason(hits: DupHit[]): string {
	const lines = hits.map(
		({ decl, match, score }) =>
			`- new "${decl.name}" ≈ existing ${match.name} (${match.filePath}:${match.startLine})` +
			`${match.signature ? ` — ${match.signature}` : ""} [similarity ${score.toFixed(2)}]`,
	);
	return [
		"lego dedup: near-duplicate symbol(s) detected — edit blocked.",
		...lines,
		"REUSE or EXTEND the existing symbol instead. If it truly does not fit, retry the same edit with a comment " +
			"on the line above the declaration: // lego:new(<one-line reason>)",
	].join("\n");
}

/** Union of candidate symbols recalled for all declarations, deduped. */
export async function collectCandidatePool(decls: Decl[], codegraph: Codegraph): Promise<CgSymbol[]> {
	const results = await Promise.all(decls.map((decl) => findCandidates(decl, codegraph)));
	const seen = new Map<string, CgSymbol>();
	for (const symbols of results) {
		for (const symbol of symbols) {
			seen.set(`${symbol.filePath}:${symbol.startLine}:${symbol.name}`, symbol);
		}
	}
	return [...seen.values()];
}

/** Best name-dice match per declaration against a candidate pool, same file excluded. */
function matchAgainstPool(decls: Decl[], path: string, pool: CgSymbol[]): DupHit[] {
	const hits: DupHit[] = [];
	for (const decl of decls) {
		let best: DupHit | undefined;
		for (const symbol of pool) {
			if (isSameFile(path, symbol.filePath)) continue;
			const score = nameSimilarity(decl.name, symbol.name);
			if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
				best = { decl, match: symbol, score };
			}
		}
		if (best) hits.push(best);
	}
	return hits;
}

/** Best near-duplicate match per declaration against codegraph, same file excluded. */
export async function findNearDuplicates(decls: Decl[], path: string, codegraph: Codegraph): Promise<DupHit[]> {
	return matchAgainstPool(decls, path, await collectCandidatePool(decls, codegraph));
}

/**
 * Evaluate an edit/write tool call. Returns undefined when the call is not
 * relevant (other tools, or no new declarations).
 */
export async function evaluateToolCall(
	toolName: string,
	input: Record<string, unknown>,
	codegraph: Codegraph,
): Promise<DedupResult | undefined> {
	if (toolName !== "edit" && toolName !== "write") return undefined;

	const { path, decls } = collectNewDeclarations(toolName, input);
	if (decls.length === 0) return undefined;

	const escaped = decls.filter((d) => d.escapeReason !== undefined);
	const candidates = await collectCandidatePool(decls, codegraph);
	const hits = matchAgainstPool(
		decls.filter((d) => d.escapeReason === undefined),
		path,
		candidates,
	);

	return {
		path,
		newSymbols: decls,
		escaped,
		hits,
		candidates,
		reason: hits.length > 0 ? formatBlockReason(hits) : undefined,
	};
}
