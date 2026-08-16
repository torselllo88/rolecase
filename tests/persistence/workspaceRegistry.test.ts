import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// workspaceRegistry.ts always resolves the ADMIN workspace's db via getDb()
// (never the caller's own ambient dataDir) — mocked here to a single shared
// in-memory db, so this test never touches the real project's data/db/app.sqlite3
// (which the actual dev server may also have open).
let sharedDb: DatabaseSync;
vi.mock("../../src/persistence/db.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/persistence/db.js")>("../../src/persistence/db.js");
  return { ...actual, getDb: () => sharedDb };
});

const { createInMemoryDb } = await import("../../src/persistence/db.js");
const {
  createWorkbench,
  deleteWorkbench,
  getWorkbench,
  listWorkbenches,
  renameWorkbench,
  updateWorkbenchPassword,
} = await import("../../src/persistence/workspaceRegistry.js");

describe("workspaceRegistry (workbench identity/auth records)", () => {
  beforeEach(() => {
    sharedDb = createInMemoryDb();
  });

  it("returns an empty list before anything is created", () => {
    expect(listWorkbenches()).toEqual([]);
  });

  it("creates a workbench and can look it up by slug", () => {
    createWorkbench({ slug: "alex", displayName: "Alex", passwordSaltHex: "aa", passwordHashHex: "bb" });

    const record = getWorkbench("alex");
    expect(record?.displayName).toBe("Alex");
    expect(record?.passwordSaltHex).toBe("aa");
    expect(record?.passwordHashHex).toBe("bb");
  });

  it("returns undefined for a slug that was never created", () => {
    expect(getWorkbench("never-created")).toBeUndefined();
  });

  it("lists multiple workbenches, oldest first", () => {
    createWorkbench({ slug: "alex", displayName: "Alex", passwordSaltHex: "a1", passwordHashHex: "a2" });
    createWorkbench({ slug: "bob", displayName: "Bob", passwordSaltHex: "b1", passwordHashHex: "b2" });

    const slugs = listWorkbenches().map((w) => w.slug);
    expect(slugs).toEqual(["alex", "bob"]);
  });

  it("renameWorkbench updates only the display name, leaving credentials untouched", () => {
    createWorkbench({ slug: "alex", displayName: "Alex", passwordSaltHex: "a1", passwordHashHex: "a2" });
    renameWorkbench("alex", "Alexandra");

    const record = getWorkbench("alex");
    expect(record?.displayName).toBe("Alexandra");
    expect(record?.passwordSaltHex).toBe("a1");
    expect(record?.passwordHashHex).toBe("a2");
  });

  it("updateWorkbenchPassword replaces the salt/hash, leaving the display name untouched", () => {
    createWorkbench({ slug: "alex", displayName: "Alex", passwordSaltHex: "old-salt", passwordHashHex: "old-hash" });
    updateWorkbenchPassword("alex", "new-salt", "new-hash");

    const record = getWorkbench("alex");
    expect(record?.passwordSaltHex).toBe("new-salt");
    expect(record?.passwordHashHex).toBe("new-hash");
    expect(record?.displayName).toBe("Alex");
  });

  it("deleteWorkbench removes the record entirely", () => {
    createWorkbench({ slug: "alex", displayName: "Alex", passwordSaltHex: "a1", passwordHashHex: "a2" });
    deleteWorkbench("alex");
    expect(getWorkbench("alex")).toBeUndefined();
    expect(listWorkbenches()).toEqual([]);
  });

  it("a slug can be recreated cleanly after being deleted", () => {
    createWorkbench({ slug: "alex", displayName: "Alex", passwordSaltHex: "a1", passwordHashHex: "a2" });
    deleteWorkbench("alex");
    createWorkbench({ slug: "alex", displayName: "New Alex", passwordSaltHex: "b1", passwordHashHex: "b2" });

    expect(getWorkbench("alex")?.displayName).toBe("New Alex");
  });

  it("rejects creating two workbenches with the same slug (PRIMARY KEY constraint)", () => {
    createWorkbench({ slug: "alex", displayName: "Alex", passwordSaltHex: "a1", passwordHashHex: "a2" });
    expect(() =>
      createWorkbench({ slug: "alex", displayName: "Someone Else", passwordSaltHex: "c1", passwordHashHex: "c2" })
    ).toThrow();
  });
});
