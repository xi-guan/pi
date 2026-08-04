/**
 * Semantic near-duplicate suspects — recall layers feeding the 3b LLM judge.
 *
 * Deterministic signals only surface SUSPECTS for the review prompt; the
 * review LLM makes the final duplicate call, so thresholds favor precision.
 * L2: shared-callee fingerprint (structure). An embedding layer (L3) was
 * removed 2026-08-04 -- see docs/lego-loop-handover.md for the measurements.
 */
import type { CgSymbol } from "./codegraph.ts";
import { type Decl, isSameFile } from "./dedup.ts";
import { extractCallNames } from "./verify.ts";

export interface SemanticSuspect {
	declName: string;
	match: CgSymbol;
	via: "callees";
	score: number;
	detail?: string;
}

/** Render suspects as review-prompt / metrics lines. */
export function formatSuspects(suspects: SemanticSuspect[]): string[] {
	return suspects.map(
		(s) =>
			`- ${s.declName} ≈ ${s.match.name} (${s.match.filePath}:${s.match.startLine}) via ${s.via}` +
			`${s.detail ? ` — ${s.detail}` : ""}`,
	);
}

export const CALLEE_MIN_SHARED = 2;
export const CALLEE_JACCARD_THRESHOLD = 0.5;
const CALLEE_CANDIDATE_CAP = 10;

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared++;
	return shared / (a.size + b.size - shared);
}

/**
 * Candidates (from dedup recall) whose callee set overlaps the new code's
 * bare calls: same helpers wired the same way — duplicate orchestration even
 * under a completely different name.
 */
export async function findCalleeSuspects(
	addedText: string,
	decls: Decl[],
	candidates: CgSymbol[],
	path: string,
	calleesFn: (name: string) => Promise<string[]>,
): Promise<SemanticSuspect[]> {
	const newCalls = new Set(extractCallNames(addedText));
	if (newCalls.size < CALLEE_MIN_SHARED) return [];
	const declName = decls[0]?.name ?? "";

	const checked = candidates
		.filter((c) => (c.kind === "function" || c.kind === "method") && !isSameFile(path, c.filePath))
		.slice(0, CALLEE_CANDIDATE_CAP);

	const suspects: SemanticSuspect[] = [];
	for (const candidate of checked) {
		const calleeNames = new Set(await calleesFn(candidate.name));
		if (calleeNames.size === 0) continue;
		const shared = [...newCalls].filter((name) => calleeNames.has(name));
		const score = jaccard(newCalls, calleeNames);
		if (shared.length >= CALLEE_MIN_SHARED && score >= CALLEE_JACCARD_THRESHOLD) {
			suspects.push({
				declName,
				match: candidate,
				via: "callees",
				score,
				detail: `shared calls: ${shared.join(", ")}`,
			});
		}
	}
	return suspects;
}
