/**
 * Thin reader over the codebase-memory-mcp sqlite index.
 *
 * All methods degrade to empty results when the index is missing, so lego
 * hooks never break the base agent.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CgSymbol {
	name: string;
	kind: string;
	filePath: string;
	startLine: number;
	signature?: string;
	isExported?: boolean;
}

/** Minimal db shape (subset of node:sqlite DatabaseSync) so tests can inject a fake. */
export interface IndexDb {
	prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** Graph labels that count as reusable bricks; filters out file/module/section noise. */
const SYMBOL_LABELS = ["Function", "Method", "Class", "Interface", "Type", "Variable"];
const CALLABLE_LABELS = ["Function", "Method"];
const holes = (values: string[]) => values.map(() => "?").join(",");

/**
 * codebase-memory-mcp keys both the db filename and the project row by the
 * absolute path with separators flattened to dashes.
 */
export function projectSlug(cwd: string): string {
	if (typeof cwd !== "string") return "";
	return cwd
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\//g, "-");
}

/** LEGO_INDEX_DB overrides the lookup, for worktrees and for tests. */
export function indexPath(cwd: string): string {
	return process.env.LEGO_INDEX_DB || join(homedir(), ".cache", "codebase-memory-mcp", `${projectSlug(cwd)}.db`);
}

/** Quote a term as an FTS5 phrase so punctuation cannot break query syntax. */
function ftsPhrase(term: string): string {
	return `name:"${term.replace(/"/g, '""')}"`;
}

/** Row -> CgSymbol, pulling signature/export flag out of the properties JSON. */
function toSymbol(row: Record<string, unknown>): CgSymbol | undefined {
	if (typeof row.name !== "string" || typeof row.label !== "string") return undefined;
	let signature: string | undefined;
	let isExported: boolean | undefined;
	try {
		const props = JSON.parse(typeof row.properties === "string" ? row.properties : "{}") as Record<string, unknown>;
		const params = typeof props.signature === "string" ? props.signature : "";
		const returns = typeof props.return_type === "string" ? props.return_type : "";
		signature = `${params}${returns}`.trim() || undefined;
		isExported = typeof props.is_exported === "boolean" ? props.is_exported : undefined;
	} catch {
		// properties is advisory; a symbol without it is still a usable brick
	}
	return {
		name: row.name,
		kind: row.label.toLowerCase(),
		filePath: typeof row.file_path === "string" ? row.file_path : "",
		startLine: typeof row.start_line === "number" ? row.start_line : 0,
		signature,
		isExported,
	};
}

function openSqlite(path: string): IndexDb | undefined {
	try {
		// createRequire, not await import: keeps connect() sync on older runtimes without node:sqlite
		const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
		return new DatabaseSync(path, { readOnly: true }) as unknown as IndexDb;
	} catch {
		return undefined;
	}
}

export class Codegraph {
	private readonly getCwd: () => string;
	private readonly open: (path: string) => IndexDb | undefined;
	private db: IndexDb | null | undefined; // null = open attempted, index absent
	private project = "";

	// no TS parameter properties: node strip-only mode must be able to run this file
	constructor(getCwd: () => string, open: (path: string) => IndexDb | undefined = openSqlite) {
		this.getCwd = getCwd;
		this.open = open;
	}

	/** Open (once per project) the index for the current cwd; undefined when absent. */
	private connect(): IndexDb | undefined {
		const cwd = this.getCwd();
		const project = projectSlug(cwd);
		if (this.db === undefined || project !== this.project) {
			this.project = project;
			this.db = this.open(indexPath(cwd)) ?? null;
		}
		return this.db ?? undefined;
	}

	/** True when the project has an index. Cached until the project changes. */
	async available(): Promise<boolean> {
		try {
			return this.connect() !== undefined;
		} catch {
			return false;
		}
	}

	/** Names of the functions/methods a symbol calls. [] on any failure. */
	async callees(symbolName: string): Promise<string[]> {
		const db = this.connect();
		if (!db) return [];
		try {
			const rows = db
				.prepare(
					`SELECT DISTINCT t.name AS name
					 FROM nodes s
					 JOIN edges e ON e.source_id = s.id AND e.type = 'CALLS'
					 JOIN nodes t ON t.id = e.target_id
					 WHERE s.project = ? AND s.name = ? AND t.label IN (${holes(CALLABLE_LABELS)})`,
				)
				.all(this.project, symbolName, ...CALLABLE_LABELS) as Array<Record<string, unknown>>;
			return rows.map((row) => row.name).filter((name): name is string => typeof name === "string");
		} catch {
			return [];
		}
	}

	/** Search symbols by name term; the index tokenizes camelCase. [] on any failure. */
	async query(name: string, limit = 10): Promise<CgSymbol[]> {
		const db = this.connect();
		if (!db) return [];
		try {
			const rows = db
				.prepare(
					`SELECT n.name, n.label, n.file_path, n.start_line, n.properties
					 FROM nodes_fts f
					 JOIN nodes n ON n.id = f.rowid
					 WHERE nodes_fts MATCH ? AND n.project = ? AND n.label IN (${holes(SYMBOL_LABELS)})
					 LIMIT ?`,
				)
				.all(ftsPhrase(name), this.project, ...SYMBOL_LABELS, limit) as Array<Record<string, unknown>>;
			const symbols: CgSymbol[] = [];
			for (const row of rows) {
				const symbol = toSymbol(row);
				if (symbol) symbols.push(symbol);
			}
			return symbols;
		} catch {
			return [];
		}
	}
}
