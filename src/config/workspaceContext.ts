import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "./env.js";

export type WorkspaceKind = "admin" | "demo" | "workbench";

export interface WorkspaceContext {
  /** "admin" | "demo" | "workbench:<slug>" | "legacy" — used to key the Orchestrator cache. */
  key: string;
  kind: WorkspaceKind;
  /** Absolute path; each workspace gets its own SQLite file + data subtree under this. */
  dataDir: string;
}

export const ADMIN_CONTEXT: WorkspaceContext = { key: "admin", kind: "admin", dataDir: env.dataDir };

const als = new AsyncLocalStorage<WorkspaceContext>();

export function runWithWorkspace<T>(ctx: WorkspaceContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getWorkspaceContext(): WorkspaceContext | undefined {
  return als.getStore();
}

/**
 * Falls back to env.dataDir when no workspace context has been entered —
 * true for the CLI, the MCP server, and the entire existing test suite, none
 * of which ever call runWithWorkspace(). That fallback is what makes this
 * refactor a no-op for all of them.
 */
export function currentDataDir(): string {
  return als.getStore()?.dataDir ?? env.dataDir;
}
