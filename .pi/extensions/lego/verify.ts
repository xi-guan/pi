/**
 * Hook 4 — verify: diff-level reuse metrics per agent run.
 *
 * Pure logic over the agent_end message list plus lego run state; the caller
 * (index.ts) resolves codegraph lookups and persists the result to
 * .pi/lego-metrics.jsonl. Every run's stats are the eval asset of the loop.
 */
import { extractDeclarations } from "./dedup.ts";

export interface RunData {
	editCount: number;
	addedText: string;
}

export interface RunStatsInput {
	editCount: number;
	newSymbols: string[];
	escapes: Array<{ name: string; reason: string }>;
	blockedCount: number;
	reviewFails: number;
	reusedCalls: number;
	missedDuplicates: string[];
	semanticFlags: string[];
}

export interface RunStats {
	edits: number;
	newSymbols: string[];
	escapes: Array<{ name: string; reason: string }>;
	blocked: number;
	reviewFails: number;
	reusedCalls: number;
	missedDuplicates: string[];
	semanticFlags: string[];
}

interface ToolCallBlock {
	type?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface MessageLike {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** Gather added code text from successful edit/write tool calls of one run. */
export function collectRunData(messages: MessageLike[]): RunData {
	const failedCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError && typeof message.toolCallId === "string") {
			failedCallIds.add(message.toolCallId);
		}
	}

	let editCount = 0;
	const added: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as ToolCallBlock[]) {
			if (block.type !== "toolCall" || (block.name !== "edit" && block.name !== "write")) continue;
			if (typeof block.id === "string" && failedCallIds.has(block.id)) continue;
			const args = block.arguments ?? {};
			editCount++;
			if (typeof args.content === "string") added.push(args.content);
			if (Array.isArray(args.edits)) {
				for (const edit of args.edits) {
					const newText = (edit as { newText?: unknown })?.newText;
					if (typeof newText === "string") added.push(newText);
				}
			}
			if (typeof (args as { newText?: unknown }).newText === "string") {
				added.push((args as { newText: string }).newText);
			}
		}
	}

	return { editCount, addedText: added.join("\n") };
}

const CALL_NAME_BLOCKLIST = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"new",
	"typeof",
	"await",
	"function",
	"super",
	"constructor",
	"console",
	"JSON",
	"Math",
	"Object",
	"Array",
	"String",
	"Number",
	"Boolean",
	"Promise",
	"Set",
	"Map",
	"Date",
	"Error",
	"Symbol",
	"RegExp",
	"parseInt",
	"parseFloat",
	"require",
	"import",
	"expect",
	"test",
	"describe",
]);

/**
 * Distinct bare call names in added code: `foo(...)` counts, `obj.foo(...)`
 * and self-declared names do not.
 */
export function extractCallNames(addedText: string, cap = 20): string[] {
	const selfDeclared = new Set(extractDeclarations(addedText).map((d) => d.name));
	const names: string[] = [];
	const seen = new Set<string>();
	// lookbehind, not a consuming group: in nested calls like f(g(x)) the char
	// before g is the ( already consumed by f's match, which would skip g
	for (const match of addedText.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
		const name = match[1];
		if (seen.has(name) || CALL_NAME_BLOCKLIST.has(name) || selfDeclared.has(name)) continue;
		seen.add(name);
		names.push(name);
		if (names.length >= cap) break;
	}
	return names;
}

/** Count distinct added-code calls that resolve to existing symbols. */
export async function countReusedCalls(
	addedText: string,
	isExistingSymbol: (name: string) => Promise<boolean>,
): Promise<number> {
	let count = 0;
	for (const name of extractCallNames(addedText)) {
		if (await isExistingSymbol(name)) count++;
	}
	return count;
}

export function aggregateStats(input: RunStatsInput): RunStats {
	return {
		edits: input.editCount,
		newSymbols: input.newSymbols,
		escapes: input.escapes,
		blocked: input.blockedCount,
		reviewFails: input.reviewFails,
		reusedCalls: input.reusedCalls,
		missedDuplicates: input.missedDuplicates,
		semanticFlags: input.semanticFlags,
	};
}
