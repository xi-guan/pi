/**
 * Rejected-decision records — `.pi/lego-notes/*.md`.
 *
 * Standalone negative results, retrieved by trigger words so a run does not
 * re-attempt an approach that was already measured and rejected. A missing
 * directory or an unparseable file yields no records; lego never throws.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LegoNote {
	name: string;
	status: string;
	date?: string;
	/** Lowercased match terms; a record fires when one appears in the text. */
	triggers: string[];
	summary: string;
}

export const NOTES_DIRNAME = join(".pi", "lego-notes");

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const FIELD_RE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

/** Flat `key: value` frontmatter; nested YAML is not supported on purpose. */
function parseFields(block: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const match = line.match(FIELD_RE);
		if (match) fields[match[1].toLowerCase()] = match[2].trim();
	}
	return fields;
}

function parseTriggers(value: string): string[] {
	return value
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		.split(",")
		.map((item) => item.trim().replace(/^["']|["']$/g, "").toLowerCase())
		.filter((item) => item.length > 0);
}

/** Parse one record file; undefined when the frontmatter is missing or incomplete. */
export function parseNote(text: string): LegoNote | undefined {
	if (typeof text !== "string") return undefined;
	const match = text.match(FRONTMATTER_RE);
	if (!match) return undefined;
	const fields = parseFields(match[1]);
	const triggers = parseTriggers(fields.triggers ?? "");
	if (!fields.name || !fields.summary || triggers.length === 0) return undefined;
	return {
		name: fields.name,
		status: fields.status || "rejected",
		date: fields.date || undefined,
		triggers,
		summary: fields.summary,
	};
}

/** All parseable records under `<projectRoot>/.pi/lego-notes`. [] on any failure. */
export async function loadNotes(projectRoot: string): Promise<LegoNote[]> {
	try {
		const dir = join(projectRoot, NOTES_DIRNAME);
		const files = (await readdir(dir)).filter((file) => file.endsWith(".md")).sort();
		const notes: LegoNote[] = [];
		for (const file of files) {
			try {
				const note = parseNote(await readFile(join(dir, file), "utf8"));
				if (note) notes.push(note);
			} catch {
				// one unreadable record must not hide the others
			}
		}
		return notes;
	} catch {
		// no records directory — retrieval is optional
		return [];
	}
}

/** Records whose triggers appear in the text (case-insensitive substring). */
export function matchNotes(text: string, notes: LegoNote[]): LegoNote[] {
	if (typeof text !== "string" || text.length === 0) return [];
	const haystack = text.toLowerCase();
	return notes.filter((note) => note.triggers.some((trigger) => haystack.includes(trigger)));
}

/** Render matched records as `name — summary` lines for prompt injection. */
export function formatNoteLines(notes: LegoNote[]): string[] {
	return notes.map((note) => `- ${note.name} — ${note.summary}`);
}

/** Header + lines, used when the records travel without a brick inventory. */
export function formatNotesBlock(lines: string[]): string {
	return [
		"Previously rejected approaches recorded in .pi/lego-notes. Do NOT re-attempt these; read the record first:",
		...lines,
	].join("\n");
}
