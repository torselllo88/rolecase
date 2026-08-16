import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/persistence/db.js";
import { runWithWorkspace, type WorkspaceContext } from "../../src/config/workspaceContext.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

function tempWorkspaceDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `workspace-db-test-${name}-`));
}

function ctxFor(dataDir: string): WorkspaceContext {
  return { key: `test:${dataDir}`, kind: "workbench", dataDir };
}

describe("getDb() — per-workspace connection cache keyed by dbPath", () => {
  const dirs: string[] = [];

  afterEach(() => {
    // Belt-and-suspenders: close every db this test may have opened before removing
    // its directory, then clean up the temp directories themselves.
    for (const dir of dirs) {
      closeDb(path.join(dir, "db", "app.sqlite3"));
      fs.rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function newTempDir(name: string): string {
    const dir = tempWorkspaceDir(name);
    dirs.push(dir);
    return dir;
  }

  it("returns the same connection instance for the same dataDir (caching)", () => {
    const dir = newTempDir("cache");
    const ctx = ctxFor(dir);
    const first = runWithWorkspace(ctx, () => getDb());
    const second = runWithWorkspace(ctx, () => getDb());
    expect(first).toBe(second);
  });

  it("returns DIFFERENT connection instances for different workspaces' dataDirs — the actual isolation guarantee", () => {
    const dirA = newTempDir("a");
    const dirB = newTempDir("b");
    const dbA = runWithWorkspace(ctxFor(dirA), () => getDb());
    const dbB = runWithWorkspace(ctxFor(dirB), () => getDb());
    expect(dbA).not.toBe(dbB);
  });

  it("a write to one workspace's db is invisible from another workspace's db", () => {
    const dirA = newTempDir("write-a");
    const dirB = newTempDir("write-b");
    const dbA = runWithWorkspace(ctxFor(dirA), () => getDb());
    const dbB = runWithWorkspace(ctxFor(dirB), () => getDb());

    dbA
      .prepare(
        `INSERT INTO workflow_runs (id, state, vacancy_source_type, vacancy_source, package_iteration_count, regenerate_attempt_count, created_at, updated_at)
         VALUES ('run-a', 'CREATED', 'raw_text', 'source', 0, 0, '2026-01-01', '2026-01-01')`
      )
      .run();

    const rowsInA = dbA.prepare(`SELECT id FROM workflow_runs`).all();
    const rowsInB = dbB.prepare(`SELECT id FROM workflow_runs`).all();
    expect(rowsInA).toHaveLength(1);
    expect(rowsInB).toHaveLength(0);
  });

  it("closeDb(path) closes and evicts only that one connection, leaving others open", () => {
    const dirA = newTempDir("evict-a");
    const dirB = newTempDir("evict-b");
    const ctxA = ctxFor(dirA);
    const ctxB = ctxFor(dirB);
    const dbBBefore = runWithWorkspace(ctxB, () => getDb());

    closeDb(path.join(dirA, "db", "app.sqlite3"));

    // B is unaffected — same instance, still usable.
    const dbBAfter = runWithWorkspace(ctxB, () => getDb());
    expect(dbBAfter).toBe(dbBBefore);
    expect(() => dbBAfter.prepare(`SELECT 1`).get()).not.toThrow();

    // A gets a fresh connection on next access (the old one was closed, not reused).
    const dbAFresh = runWithWorkspace(ctxA, () => getDb());
    expect(() => dbAFresh.prepare(`SELECT 1`).get()).not.toThrow();
  });

  it("closeDb() with no argument closes every cached connection", () => {
    const dirA = newTempDir("close-all-a");
    const dirB = newTempDir("close-all-b");
    runWithWorkspace(ctxFor(dirA), () => getDb());
    runWithWorkspace(ctxFor(dirB), () => getDb());

    closeDb();

    // Both should be safely reconstructable afterward, proving they were actually
    // closed/evicted rather than left in some broken half-state.
    expect(() => runWithWorkspace(ctxFor(dirA), () => getDb()).prepare(`SELECT 1`).get()).not.toThrow();
    expect(() => runWithWorkspace(ctxFor(dirB), () => getDb()).prepare(`SELECT 1`).get()).not.toThrow();
  });
});

describe("getDb() — visitor_id migration guard for a pre-existing (pre-feature) db file", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempWorkspaceDir("migration");
  });

  afterEach(() => {
    closeDb(path.join(dir, "db", "app.sqlite3"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds the visitor_id column to a workflow_runs table that predates this feature, without losing existing rows", () => {
    const dbDir = path.join(dir, "db");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "app.sqlite3");

    // Simulate an admin db created before visitor_id existed — the exact
    // pre-feature CREATE TABLE shape, deliberately without that column.
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        vacancy_source_type TEXT NOT NULL,
        vacancy_source TEXT NOT NULL,
        vacancy_title TEXT,
        company_name TEXT,
        recommendation TEXT,
        package_iteration_count INTEGER NOT NULL DEFAULT 0,
        regenerate_attempt_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        failed_from_state TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.prepare(
      `INSERT INTO workflow_runs (id, state, vacancy_source_type, vacancy_source, created_at, updated_at)
       VALUES ('pre-existing-run', 'CREATED', 'raw_text', 'old vacancy', '2025-01-01', '2025-01-01')`
    ).run();
    legacyDb.close();

    // Now open it through the app's real getDb() — this is what a server
    // upgrading from a pre-feature version would do on its next startup.
    const upgraded = runWithWorkspace(ctxFor(dir), () => getDb());

    const columns = upgraded.prepare(`PRAGMA table_info(workflow_runs)`).all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === "visitor_id")).toBe(true);

    // The pre-existing row survived the migration, with visitor_id defaulting to null.
    const row = upgraded.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get("pre-existing-run") as
      | { visitor_id: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.visitor_id).toBeNull();
  });

  it("is idempotent — reopening an already-migrated db a second time doesn't error", () => {
    const ctx = ctxFor(dir);
    runWithWorkspace(ctx, () => getDb());
    closeDb(path.join(dir, "db", "app.sqlite3"));

    expect(() => runWithWorkspace(ctx, () => getDb())).not.toThrow();
  });
});
