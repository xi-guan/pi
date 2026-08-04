import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { projectSlug } from "./codegraph.ts";
import { type FixtureSymbol, INDEX_SCHEMA, insertSymbols } from "./fixtures.ts";
import legoExtension from "./index.ts";

// minimal stub of the ExtensionAPI surface the factory touches
function createPiStub() {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const entries: Array<[string, unknown]> = [];
	return {
		commands,
		handlers,
		entries,
		api: {
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			registerCommand: (name: string, options: { description?: string; handler: never }) => {
				commands.set(name, options as never);
			},
			on: (event: string, handler: never) => {
				handlers.set(event, handler);
			},
			appendEntry: (kind: string, data: unknown) => {
				entries.push([kind, data]);
			},
		},
	};
}

/** One index hit for `normalizeToLF`, the symbol every fixture near-duplicates. */
const NORMALIZE_TO_LF: FixtureSymbol[] = [
	{
		id: 1,
		label: "Function",
		name: "normalizeToLF",
		filePath: "packages/coding-agent/src/core/tools/edit-diff.ts",
		properties: { signature: "(text: string)", return_type: ": string" },
	},
];

const originalIndexEnv = process.env.LEGO_INDEX_DB;
after(() => {
	if (originalIndexEnv === undefined) delete process.env.LEGO_INDEX_DB;
	else process.env.LEGO_INDEX_DB = originalIndexEnv;
});

/**
 * A real on-disk index for `cwd`, pointed at by LEGO_INDEX_DB. Returns an `add`
 * so a test can grow the index mid-run, as a background re-index would.
 */
async function makeIndexFile(cwd: string, symbols: FixtureSymbol[]) {
	const path = join(await mkdtemp(join(tmpdir(), "lego-db-")), "index.db");
	const db = new DatabaseSync(path);
	db.exec(INDEX_SCHEMA);
	const project = projectSlug(cwd);
	insertSymbols(db, symbols, [], project);
	process.env.LEGO_INDEX_DB = path;
	return { add: (more: FixtureSymbol[]) => insertSymbols(db, more, [], project) };
}

test("factory registers /lego command", async () => {
	const stub = createPiStub();
	await legoExtension(stub.api as never);
	assert.ok(stub.commands.has("lego"));
});

test("/lego reports availability via notify", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "lego-test-"));
	await makeIndexFile(cwd, NORMALIZE_TO_LF);
	const stub = createPiStub();
	await legoExtension(stub.api as never);
	const notifications: Array<[string, string]> = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
	};
	await stub.commands.get("lego")!.handler("", ctx as never);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0][0], /hooks active/);
	assert.equal(notifications[0][1], "info");
});

test("/lego warns when the index is missing", async () => {
	process.env.LEGO_INDEX_DB = join(tmpdir(), "lego-absent", "nope.db");
	const stub = createPiStub();
	await legoExtension(stub.api as never);
	const notifications: Array<[string, string]> = [];
	const ctx = {
		cwd: "/nowhere",
		hasUI: true,
		ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
	};
	await stub.commands.get("lego")!.handler("", ctx as never);
	assert.match(notifications[0][0], /index MISSING/);
	assert.equal(notifications[0][1], "warning");
});

const ESCAPED_DUPLICATE = [
	"// lego:new(scratchpad only)",
	"export function normalizeCrlfToLf(text: string): string {",
	"\treturn text;",
	"}",
].join("\n");

/** Drive tool_call then agent_end over one write, returning the persisted run stats. */
async function runWriteThenEnd(
	stub: ReturnType<typeof createPiStub>,
	content: string,
	cwd: string,
	beforeEnd?: () => void,
) {
	await legoExtension(stub.api as never);
	const input = { path: "scratch/x.ts", content };
	const blocked = await stub.handlers.get("tool_call")!({ toolName: "write", toolCallId: "call-1", input }, {
		cwd,
	} as never);
	beforeEnd?.();
	await stub.handlers.get("agent_end")!(
		{ messages: [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: input }] }] },
		{ cwd, hasUI: false } as never,
	);
	const stats = stub.entries.find(([kind]) => kind === "lego-verify")?.[1] as {
		escapes: Array<{ name: string }>;
		missedDuplicates: string[];
	};
	return { blocked, stats };
}

test("agent_end does not re-report an escaped duplicate as missed", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "lego-test-"));
	await makeIndexFile(cwd, NORMALIZE_TO_LF);
	const stub = createPiStub();
	const { blocked, stats } = await runWriteThenEnd(stub, ESCAPED_DUPLICATE, cwd);

	assert.equal(blocked, undefined, "escape hatch lets the write through");
	assert.deepEqual(
		stats.escapes.map((e) => e.name),
		["normalizeCrlfToLf"],
	);
	assert.deepEqual(stats.missedDuplicates, [], "a conscious escape is not a missed duplicate");
});

test("agent_end still reports a duplicate the tool_call gate could not see", async () => {
	// the index only learns about normalizeToLF after the write was already allowed
	const cwd = await mkdtemp(join(tmpdir(), "lego-test-"));
	const index = await makeIndexFile(cwd, []);
	const stub = createPiStub();
	const unescaped = ESCAPED_DUPLICATE.split("\n").slice(1).join("\n");

	const { blocked, stats } = await runWriteThenEnd(stub, unescaped, cwd, () => index.add(NORMALIZE_TO_LF));

	assert.equal(blocked, undefined, "nothing to block: the index was empty at tool_call time");
	assert.equal(stats.missedDuplicates.length, 1, "a genuine miss must still surface");
	assert.match(stats.missedDuplicates[0], /normalizeCrlfToLf ≈ normalizeToLF/);
});
