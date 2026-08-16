import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config/env.js";

const { getWorkbench } = vi.hoisted(() => ({ getWorkbench: vi.fn() }));
vi.mock("../../src/persistence/workspaceRegistry.js", () => ({ getWorkbench }));

const { isWorkspacesEnabled, resolveWorkspace, rootRedirectTarget, demoDescriptorIfEnabled, workbenchDataDir } =
  await import("../../src/gui/workspaces.js");

describe("resolveWorkspace", () => {
  const originalAdminPassword = env.adminPassword;
  const originalEnableDemo = env.enableDemo;

  afterEach(() => {
    env.adminPassword = originalAdminPassword;
    env.enableDemo = originalEnableDemo;
    getWorkbench.mockReset();
  });

  describe("when ADMIN_PASSWORD is unset (legacy/single-instance mode)", () => {
    beforeEach(() => {
      env.adminPassword = undefined;
    });

    it("resolves EVERY path to the same legacy descriptor, byte for byte, with no prefix stripped", () => {
      for (const pathname of ["/", "/admin", "/demo", "/workbench/alex", "/api/runs", "/anything/else"]) {
        const resolved = resolveWorkspace(pathname);
        expect(resolved).not.toBe("not-found");
        if (resolved !== "not-found" && !("redirectTo" in resolved)) {
          expect(resolved.descriptor.key).toBe("legacy");
          expect(resolved.descriptor.requiresAuth).toBe(false);
          expect(resolved.descriptor.dataDir).toBe(env.dataDir);
          expect(resolved.rest).toBe(pathname); // unchanged — no stripping in legacy mode
        }
      }
    });

    it("isWorkspacesEnabled() is false", () => {
      expect(isWorkspacesEnabled()).toBe(false);
    });
  });

  describe("when ADMIN_PASSWORD is set", () => {
    beforeEach(() => {
      env.adminPassword = "test-password";
    });

    it("isWorkspacesEnabled() is true", () => {
      expect(isWorkspacesEnabled()).toBe(true);
    });

    it("resolves /admin to the admin descriptor, requiring auth", () => {
      const resolved = resolveWorkspace("/admin");
      expect(resolved).not.toBe("not-found");
      if (resolved !== "not-found" && !("redirectTo" in resolved)) {
        expect(resolved.descriptor.kind).toBe("admin");
        expect(resolved.descriptor.requiresAuth).toBe(true);
        expect(resolved.descriptor.dataDir).toBe(env.dataDir); // zero-migration: same dir as legacy
        expect(resolved.rest).toBe("/");
      }
    });

    it("strips the /admin prefix, leaving the remainder as `rest`", () => {
      const resolved = resolveWorkspace("/admin/api/runs");
      if (resolved !== "not-found" && !("redirectTo" in resolved)) {
        expect(resolved.rest).toBe("/api/runs");
      } else {
        throw new Error("expected a resolved descriptor");
      }
    });

    describe("demo", () => {
      it("resolves /demo only when ENABLE_DEMO is also true", () => {
        env.enableDemo = true;
        const resolved = resolveWorkspace("/demo");
        expect(resolved).not.toBe("not-found");
        if (resolved !== "not-found" && !("redirectTo" in resolved)) {
          expect(resolved.descriptor.kind).toBe("demo");
          expect(resolved.descriptor.requiresAuth).toBe(false); // no password — anonymous session instead
        }
      });

      it("does NOT resolve /demo when ENABLE_DEMO is false, even with ADMIN_PASSWORD set — the two flags are independent", () => {
        env.enableDemo = false;
        expect(resolveWorkspace("/demo")).toBe("not-found");
      });

      it("demoDescriptorIfEnabled() is undefined unless BOTH ADMIN_PASSWORD and ENABLE_DEMO are set", () => {
        env.enableDemo = false;
        expect(demoDescriptorIfEnabled()).toBeUndefined();
        env.enableDemo = true;
        expect(demoDescriptorIfEnabled()).toBeDefined();
      });
    });

    describe("workbench", () => {
      it("resolves /workbench/<slug> only when that slug is a real, registered workbench", () => {
        getWorkbench.mockReturnValue({ slug: "alex", displayName: "Alex" });
        const resolved = resolveWorkspace("/workbench/alex");
        expect(resolved).not.toBe("not-found");
        if (resolved !== "not-found" && !("redirectTo" in resolved)) {
          expect(resolved.descriptor.kind).toBe("workbench");
          expect(resolved.descriptor.key).toBe("workbench:alex");
          expect(resolved.descriptor.requiresAuth).toBe(true);
          expect(resolved.descriptor.dataDir).toBe(workbenchDataDir("alex"));
        }
      });

      it("returns not-found for a slug that isn't registered — same shape as an invalid slug, no existence oracle", () => {
        getWorkbench.mockReturnValue(undefined);
        expect(resolveWorkspace("/workbench/never-created")).toBe("not-found");
      });

      it("rejects a slug that doesn't match the allowed pattern, without ever calling getWorkbench (no injection surface)", () => {
        expect(resolveWorkspace("/workbench/../../etc")).toBe("not-found");
        expect(resolveWorkspace("/workbench/Has_Upper_And_Underscore")).toBe("not-found");
        expect(getWorkbench).not.toHaveBeenCalled();
      });

      it("strips the /workbench/<slug> prefix, leaving the remainder as `rest`", () => {
        getWorkbench.mockReturnValue({ slug: "alex", displayName: "Alex" });
        const resolved = resolveWorkspace("/workbench/alex/api/runs");
        if (resolved !== "not-found" && !("redirectTo" in resolved)) {
          expect(resolved.rest).toBe("/api/runs");
        } else {
          throw new Error("expected a resolved descriptor");
        }
      });
    });

    describe("bare / redirect", () => {
      it("redirects to /demo when demo is enabled", () => {
        env.enableDemo = true;
        expect(resolveWorkspace("/")).toEqual({ redirectTo: "/demo" });
      });

      it("redirects to /admin when demo is not enabled", () => {
        env.enableDemo = false;
        expect(resolveWorkspace("/")).toEqual({ redirectTo: "/admin" });
      });

      it("rootRedirectTarget() matches the same logic resolveWorkspace('/') uses", () => {
        env.enableDemo = true;
        expect(rootRedirectTarget()).toBe("/demo");
        env.enableDemo = false;
        expect(rootRedirectTarget()).toBe("/admin");
      });
    });

    it("returns not-found for any unrecognized path", () => {
      expect(resolveWorkspace("/some/random/path")).toBe("not-found");
    });
  });
});
