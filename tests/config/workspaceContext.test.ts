import { describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import {
  ADMIN_CONTEXT,
  currentDataDir,
  getWorkspaceContext,
  runWithWorkspace,
  type WorkspaceContext,
} from "../../src/config/workspaceContext.js";

describe("workspaceContext", () => {
  it("falls back to env.dataDir when no workspace context has been entered", () => {
    // No runWithWorkspace() call wraps this — this is exactly the fallback that
    // makes the whole feature a no-op for the CLI, the MCP server, and every
    // other test in this suite.
    expect(currentDataDir()).toBe(env.dataDir);
    expect(getWorkspaceContext()).toBeUndefined();
  });

  it("currentDataDir() resolves to the entered context's dataDir while inside runWithWorkspace()", () => {
    const ctx: WorkspaceContext = { key: "demo", kind: "demo", dataDir: "/fake/demo/dir" };
    const observed = runWithWorkspace(ctx, () => currentDataDir());
    expect(observed).toBe("/fake/demo/dir");
  });

  it("reverts to the fallback once execution leaves the runWithWorkspace() callback", () => {
    const ctx: WorkspaceContext = { key: "demo", kind: "demo", dataDir: "/fake/demo/dir" };
    runWithWorkspace(ctx, () => currentDataDir());
    expect(currentDataDir()).toBe(env.dataDir);
  });

  it("propagates through an async/await chain inside the callback", async () => {
    const ctx: WorkspaceContext = { key: "workbench:alex", kind: "workbench", dataDir: "/fake/alex/dir" };
    const observed = await runWithWorkspace(ctx, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentDataDir();
    });
    expect(observed).toBe("/fake/alex/dir");
  });

  it("keeps two concurrently-running contexts isolated from each other (no cross-talk on shared async execution)", async () => {
    const ctxA: WorkspaceContext = { key: "workbench:alex", kind: "workbench", dataDir: "/fake/alex" };
    const ctxB: WorkspaceContext = { key: "workbench:bob", kind: "workbench", dataDir: "/fake/bob" };

    const readAfterDelay = (ms: number) =>
      new Promise<string>((resolve) => setTimeout(() => resolve(currentDataDir()), ms));

    const [resultA, resultB] = await Promise.all([
      runWithWorkspace(ctxA, () => readAfterDelay(20)),
      runWithWorkspace(ctxB, () => readAfterDelay(5)),
    ]);

    expect(resultA).toBe("/fake/alex");
    expect(resultB).toBe("/fake/bob");
  });

  it("getWorkspaceContext() returns the full context object while inside runWithWorkspace()", () => {
    const ctx: WorkspaceContext = { key: "admin", kind: "admin", dataDir: "/fake/admin" };
    const observed = runWithWorkspace(ctx, () => getWorkspaceContext());
    expect(observed).toEqual(ctx);
  });

  it("ADMIN_CONTEXT always points at env.dataDir, matching the admin workspace's own unprefixed directory", () => {
    expect(ADMIN_CONTEXT.dataDir).toBe(env.dataDir);
    expect(ADMIN_CONTEXT.kind).toBe("admin");
  });
});
