import { describe, expect, it } from "vitest";
import {
  createSession,
  destroySession,
  destroySessionsForWorkspace,
  getSession,
} from "../../../src/gui/auth/session.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("session store", () => {
  it("returns the session for a token just created", () => {
    const token = createSession("admin", "admin", 60_000);
    const session = getSession(token);
    expect(session?.workspaceKey).toBe("admin");
    expect(session?.kind).toBe("admin");
  });

  it("returns undefined for an unknown token", () => {
    expect(getSession("this-token-was-never-issued")).toBeUndefined();
  });

  it("returns undefined for an undefined token (no Cookie header at all)", () => {
    expect(getSession(undefined)).toBeUndefined();
  });

  it("destroySession invalidates the token immediately", () => {
    const token = createSession("admin", "admin", 60_000);
    expect(getSession(token)).toBeDefined();
    destroySession(token);
    expect(getSession(token)).toBeUndefined();
  });

  it("a session naturally expires once its TTL elapses", async () => {
    const token = createSession("workbench:alex", "workbench", 10);
    expect(getSession(token)).toBeDefined();
    await sleep(30);
    expect(getSession(token)).toBeUndefined();
  });

  it("issues a distinct, unpredictable token on every call", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => createSession("demo", "demo", 60_000)));
    expect(tokens.size).toBe(20);
  });

  describe("destroySessionsForWorkspace", () => {
    it("destroys every session for the given workspace key, leaving others untouched", () => {
      const aliceToken1 = createSession("workbench:alex", "workbench", 60_000);
      const aliceToken2 = createSession("workbench:alex", "workbench", 60_000);
      const bobToken = createSession("workbench:bob", "workbench", 60_000);
      const adminToken = createSession("admin", "admin", 60_000);

      destroySessionsForWorkspace("workbench:alex");

      expect(getSession(aliceToken1)).toBeUndefined();
      expect(getSession(aliceToken2)).toBeUndefined();
      expect(getSession(bobToken)).toBeDefined();
      expect(getSession(adminToken)).toBeDefined();
    });

    it("is a no-op for a workspace key with no active sessions", () => {
      expect(() => destroySessionsForWorkspace("workbench:never-existed")).not.toThrow();
    });
  });
});
