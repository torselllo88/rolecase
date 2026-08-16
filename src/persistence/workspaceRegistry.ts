import { ADMIN_CONTEXT, runWithWorkspace } from "../config/workspaceContext.js";
import { getDb } from "./db.js";

export interface WorkbenchRecord {
  slug: string;
  displayName: string;
  passwordSaltHex: string;
  passwordHashHex: string;
  createdAt: string;
}

interface WorkbenchRow {
  slug: string;
  display_name: string;
  password_salt_hex: string;
  password_hash_hex: string;
  created_at: string;
}

function rowToRecord(row: WorkbenchRow): WorkbenchRecord {
  return {
    slug: row.slug,
    displayName: row.display_name,
    passwordSaltHex: row.password_salt_hex,
    passwordHashHex: row.password_hash_hex,
    createdAt: row.created_at,
  };
}

/**
 * The `workspaces` table lives in the ADMIN workspace's own db file, never in
 * a requesting workbench's own db — so every function here explicitly opens
 * the admin db via ADMIN_CONTEXT, regardless of which workspace's
 * WorkspaceContext is ambient for the current request. Reading it through
 * the caller's own currentDataDir() would look for this table inside an
 * unrelated (and usually workbench-scoped) db file and fail.
 */
function adminDb() {
  return runWithWorkspace(ADMIN_CONTEXT, () => getDb());
}

export function listWorkbenches(): WorkbenchRecord[] {
  const rows = adminDb().prepare(`SELECT * FROM workspaces ORDER BY created_at ASC`).all() as unknown as WorkbenchRow[];
  return rows.map(rowToRecord);
}

export function getWorkbench(slug: string): WorkbenchRecord | undefined {
  const row = adminDb().prepare(`SELECT * FROM workspaces WHERE slug = ?`).get(slug) as unknown as
    | WorkbenchRow
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function createWorkbench(input: {
  slug: string;
  displayName: string;
  passwordSaltHex: string;
  passwordHashHex: string;
}): WorkbenchRecord {
  const now = new Date().toISOString();
  adminDb()
    .prepare(
      `INSERT INTO workspaces (slug, display_name, password_salt_hex, password_hash_hex, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.slug, input.displayName, input.passwordSaltHex, input.passwordHashHex, now);
  return getWorkbench(input.slug)!;
}

export function renameWorkbench(slug: string, displayName: string): void {
  adminDb().prepare(`UPDATE workspaces SET display_name = ? WHERE slug = ?`).run(displayName, slug);
}

export function updateWorkbenchPassword(slug: string, saltHex: string, hashHex: string): void {
  adminDb()
    .prepare(`UPDATE workspaces SET password_salt_hex = ?, password_hash_hex = ? WHERE slug = ?`)
    .run(saltHex, hashHex, slug);
}

export function deleteWorkbench(slug: string): void {
  adminDb().prepare(`DELETE FROM workspaces WHERE slug = ?`).run(slug);
}
