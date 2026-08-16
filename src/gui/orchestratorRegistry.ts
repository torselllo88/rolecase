import { getDb } from "../persistence/db.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SettingsRepository, type AppSettings } from "../persistence/settingsRepository.js";
import { ADMIN_CONTEXT, runWithWorkspace, type WorkspaceContext } from "../config/workspaceContext.js";

/** Workbench-only LLM fallback source — reads the ADMIN workspace's own settings row explicitly (never the requesting workbench's ambient dataDir), since that's where an admin-wide key/provider actually lives. */
function getAdminSettings(): AppSettings {
  const adminDb = runWithWorkspace(ADMIN_CONTEXT, () => getDb());
  return new SettingsRepository(adminDb).getSettings();
}

/**
 * Safe generalization of the old single module-level `orchestrator`
 * instance: two concurrent requests for DIFFERENT workspaces now get
 * DIFFERENT instances (no shared state, no race); two for the SAME
 * workspace still share one instance exactly as before — activeSteps (the
 * per-run concurrency guard) and SearchBroker's rate-limit/cache state
 * still correctly persist across requests for that one workspace.
 */
const cache = new Map<string, Orchestrator>();

export function getOrchestratorForWorkspace(ctx: WorkspaceContext): Orchestrator {
  const cached = cache.get(ctx.key);
  if (cached) return cached;

  const db = runWithWorkspace(ctx, () => getDb());
  const orchestrator = new Orchestrator(db, {
    forceStubLlm: ctx.kind === "demo",
    forceStubSearch: ctx.kind === "demo",
    llmFallbackSettings: ctx.kind === "workbench" ? getAdminSettings : undefined,
  });
  cache.set(ctx.key, orchestrator);
  return orchestrator;
}

/** Used when resetting/deleting a workbench — the next request rebuilds fresh against the (now-empty) directory. */
export function evictOrchestratorForWorkspace(workspaceKey: string): void {
  cache.delete(workspaceKey);
}

/** Peeks the cache without constructing anything — used to check for in-flight steps before a destructive reset/delete, without spinning up an Orchestrator just to ask it. */
export function peekOrchestratorForWorkspace(workspaceKey: string): Orchestrator | undefined {
  return cache.get(workspaceKey);
}

/**
 * Called after the ADMIN's own settings are saved — every already-cached
 * workbench Orchestrator captured `getAdminSettings` as a live thunk at
 * construction time, but nothing re-invokes it on an existing instance on
 * its own; `refreshLlmProvider()`/`refreshSearchBroker()` are what actually
 * re-resolve and rebuild the LLM provider / Brave Search key from that
 * thunk. Without this call, a workbench with no key of its own keeps using
 * a stale admin key until its cache entry happens to be evicted some other
 * way (reset/delete/restart).
 */
export function refreshWorkbenchLlmProviders(): void {
  for (const [key, orchestrator] of cache) {
    if (key.startsWith("workbench:")) {
      orchestrator.refreshLlmProvider();
      orchestrator.refreshSearchBroker();
    }
  }
}
