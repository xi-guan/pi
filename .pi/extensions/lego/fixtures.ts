/**
 * In-memory stand-in for the codebase-memory-mcp index, used by tests so they
 * exercise the real SQL instead of a hand-rolled fake. Not imported by the
 * extension itself.
 */
import { DatabaseSync } from "node:sqlite";
import type { IndexDb } from "./codegraph.ts";

export interface FixtureSymbol {
	id: number;
	label: string;
	name: string;
	filePath: string;
	/** Overrides the default project; use `<project>::missed` to test filtering. */
	project?: string;
	properties?: Record<string, unknown>;
	startLine?: number;
	endLine?: number;
}

export const FIXTURE_PROJECT = "repo-root";
export const FIXTURE_CWD = `/${FIXTURE_PROJECT}`;

export const INDEX_SCHEMA = `
	CREATE TABLE IF NOT EXISTS nodes (id INTEGER PRIMARY KEY, project TEXT, label TEXT, name TEXT,
		qualified_name TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER, properties TEXT);
	CREATE TABLE IF NOT EXISTS edges (id INTEGER PRIMARY KEY, project TEXT, source_id INTEGER, target_id INTEGER, type TEXT);
	CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(name, qualified_name, label, file_path, content='');
`;

/** Populate an index-shaped db; `calls` are source-id -> target-id CALLS edges. */
export function insertSymbols(
	db: DatabaseSync,
	symbols: FixtureSymbol[],
	calls: Array<[number, number]> = [],
	project = FIXTURE_PROJECT,
): void {
	const insertNode = db.prepare(
		"INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties) VALUES (?,?,?,?,?,?,?,?,?)",
	);
	const insertFts = db.prepare("INSERT INTO nodes_fts (rowid, name, qualified_name, label, file_path) VALUES (?,?,?,?,?)");
	for (const symbol of symbols) {
		insertNode.run(
			symbol.id,
			symbol.project ?? project,
			symbol.label,
			symbol.name,
			symbol.name,
			symbol.filePath,
			symbol.startLine ?? 18,
			symbol.endLine ?? 30,
			JSON.stringify(symbol.properties ?? {}),
		);
		// the real indexer splits camelCase into the fts name column; mirror that
		insertFts.run(
			symbol.id,
			`${symbol.name} ${symbol.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}`,
			symbol.name,
			symbol.label,
			symbol.filePath,
		);
	}

	const insertEdge = db.prepare("INSERT INTO edges (project, source_id, target_id, type) VALUES (?,?,?,?)");
	for (const [source, target] of calls) insertEdge.run(project, source, target, "CALLS");
}

/** In-memory index for unit tests that never need a file on disk. */
export function makeIndexDb(symbols: FixtureSymbol[], calls: Array<[number, number]> = []): IndexDb {
	const db = new DatabaseSync(":memory:");
	db.exec(INDEX_SCHEMA);
	insertSymbols(db, symbols, calls);
	return db as unknown as IndexDb;
}
