import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { currentDataDir } from "../config/workspaceContext.js";
import { INIT_SQL } from "./migrations/001_init.js";

// node:sqlite is a prefix-only builtin (isBuiltin("sqlite") is false, only
// isBuiltin("node:sqlite") is true) and isn't in Node's public builtinModules
// list yet since it's still experimental. Vite/vite-node's ESM externalization
// strips the "node:" prefix before resolving, which breaks a static
// `import ... from "node:sqlite"` under vitest. Going through Node's own
// CommonJS require() sidesteps Vite's module pipeline entirely.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

// Keyed by resolved dbPath rather than a single instance — each workspace
// (admin/demo/each workbench) gets its own SQLite file under its own
// currentDataDir(), so this is a cache of independent connections, not a
// single global singleton.
const dbInstances = new Map<string, DatabaseSyncType>();

/** ALTER TABLE ... ADD COLUMN IF NOT EXISTS is not valid SQLite syntax — this
 *  guard is what actually adds a new nullable column to a pre-existing DB
 *  whose CREATE TABLE predates that column (INIT_SQL's CREATE TABLE IF NOT
 *  EXISTS is a no-op against an already-existing table). No-op for a brand
 *  new DB, which already gets the column straight from INIT_SQL. */
function ensureColumn(db: DatabaseSyncType, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function applyMigrations(db: DatabaseSyncType): void {
  db.exec(INIT_SQL);
  ensureColumn(db, "workflow_runs", "visitor_id", "visitor_id TEXT");
  ensureColumn(db, "workflow_runs", "salary_location_override", "salary_location_override TEXT");
  ensureColumn(db, "app_settings", "default_avoid_overfitting", "default_avoid_overfitting INTEGER");
  ensureColumn(db, "app_settings", "agent_instructions_json", "agent_instructions_json TEXT");
  ensureColumn(db, "app_settings", "brave_search_api_key", "brave_search_api_key TEXT");
  ensureColumn(db, "app_settings", "openrouter_model_by_consumer_json", "openrouter_model_by_consumer_json TEXT");
  ensureColumn(db, "app_settings", "max_writer_critic_iterations", "max_writer_critic_iterations INTEGER");
}

export function getDb(): DatabaseSyncType {
  const dbDir = path.join(currentDataDir(), "db");
  const dbPath = path.join(dbDir, "app.sqlite3");

  const cached = dbInstances.get(dbPath);
  if (cached) return cached;

  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Default busy_timeout is 0ms — a second writer (e.g. a CLI command run
  // while the GUI server holds this file open) would otherwise get an
  // immediate SQLITE_BUSY exception instead of waiting a reasonable amount
  // for the first writer's transaction to finish.
  db.exec("PRAGMA busy_timeout = 5000;");
  applyMigrations(db);

  dbInstances.set(dbPath, db);
  return db;
}

/** Test-only escape hatch: a fresh in-memory DB with migrations applied. */
export function createInMemoryDb(): DatabaseSyncType {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applyMigrations(db);
  return db;
}

/** No-arg form closes every cached connection (matches today's single-instance
 *  behavior); pass a specific dbPath to close and evict just one workspace's
 *  connection (used when resetting/deleting a workbench). */
export function closeDb(dbPath?: string): void {
  if (dbPath) {
    dbInstances.get(dbPath)?.close();
    dbInstances.delete(dbPath);
    return;
  }
  for (const db of dbInstances.values()) db.close();
  dbInstances.clear();
}

/**
 * node:sqlite's DatabaseSync has no built-in `.transaction()` helper (unlike
 * better-sqlite3) — this wraps the same BEGIN/COMMIT/ROLLBACK pattern by hand.
 */
export function withTransaction<T>(db: DatabaseSyncType, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
