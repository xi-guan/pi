import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	formatNoteLines,
	formatNotesBlock,
	type LegoNote,
	loadNotes,
	matchNotes,
	NOTES_DIRNAME,
	parseNote,
} from "./notes.ts";

const RECORD = [
	"---",
	"name: soft-bounce-has-no-force",
	"status: rejected",
	"date: 2026-08-20",
	"triggers: [Soft Bounce, 软打回, semantic dedup]",
	"summary: Hard blocks change model behavior, soft bounces do not.",
	"---",
	"",
	"正文, 中文, 不参与匹配。",
].join("\n");

/** A temp project root with `.pi/lego-notes` populated from name -> file text. */
async function makeNotesDir(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "lego-notes-"));
	await mkdir(join(root, NOTES_DIRNAME), { recursive: true });
	for (const [name, text] of Object.entries(files)) await writeFile(join(root, NOTES_DIRNAME, name), text);
	return root;
}

// ── parseNote

test("parses frontmatter and lowercases triggers", () => {
	const note = parseNote(RECORD);
	assert.ok(note);
	assert.equal(note.name, "soft-bounce-has-no-force");
	assert.equal(note.status, "rejected");
	assert.equal(note.date, "2026-08-20");
	assert.deepEqual(note.triggers, ["soft bounce", "软打回", "semantic dedup"]);
	assert.equal(note.summary, "Hard blocks change model behavior, soft bounces do not.");
});

test("rejects records without frontmatter, name, summary, or triggers", () => {
	assert.equal(parseNote("just a markdown file\n"), undefined);
	assert.equal(parseNote("---\nname: x\ntriggers: [a]\n---\nbody"), undefined, "no summary");
	assert.equal(parseNote("---\nname: x\nsummary: s\n---\nbody"), undefined, "no triggers");
	assert.equal(parseNote("---\ntriggers: [a]\nsummary: s\n---\nbody"), undefined, "no name");
	assert.equal(parseNote(undefined as never), undefined);
});

// ── loadNotes

test("loads parseable records and skips the unparseable ones", async () => {
	const root = await makeNotesDir({
		"a.md": RECORD,
		"b.md": "not a record at all",
		"c.txt": RECORD,
	});
	const notes = await loadNotes(root);
	assert.deepEqual(
		notes.map((n) => n.name),
		["soft-bounce-has-no-force"],
	);
});

test("missing records directory yields no records", async () => {
	const root = await mkdtemp(join(tmpdir(), "lego-empty-"));
	assert.deepEqual(await loadNotes(root), []);
	assert.deepEqual(await loadNotes("/nowhere/at/all"), []);
});

// ── matchNotes / formatting

const NOTES: LegoNote[] = [
	{ name: "n1", status: "rejected", triggers: ["embedding", "cosine"], summary: "s1" },
	{ name: "n2", status: "rejected", triggers: ["soft bounce"], summary: "s2" },
];

test("matches triggers as case-insensitive substrings", () => {
	assert.deepEqual(
		matchNotes("Try an EMBEDDING layer again", NOTES).map((n) => n.name),
		["n1"],
	);
	assert.deepEqual(
		matchNotes("the soft bounce never worked", NOTES).map((n) => n.name),
		["n2"],
	);
	assert.deepEqual(
		matchNotes("cosine ranking plus a Soft Bounce", NOTES).map((n) => n.name),
		["n1", "n2"],
	);
});

test("returns no records for unrelated or empty text", () => {
	assert.deepEqual(matchNotes("rename a variable", NOTES), []);
	assert.deepEqual(matchNotes("", NOTES), []);
	assert.deepEqual(matchNotes("embedding", []), []);
});

test("formats records as name — summary lines under a do-not-retry header", () => {
	const lines = formatNoteLines(NOTES);
	assert.deepEqual(lines, ["- n1 — s1", "- n2 — s2"]);
	const block = formatNotesBlock(lines);
	assert.match(block, /\.pi\/lego-notes/);
	assert.match(block, /- n1 — s1/);
});
