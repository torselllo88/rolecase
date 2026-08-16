import path from "node:path";
import { env } from "../config/env.js";
import type { WorkspaceContext } from "../config/workspaceContext.js";
import { getWorkbench } from "../persistence/workspaceRegistry.js";

export interface WorkspaceDescriptor extends WorkspaceContext {
  /** "" | "/admin" | "/demo" | "/workbench/<slug>" — used both for cookie Path scoping and for stripping the request's pathname. */
  urlPrefix: string;
  requiresAuth: boolean;
}

/** When ADMIN_PASSWORD is unset, every request resolves to this one constant — no prefix
 *  stripping, no auth, dataDir unprefixed — so a fresh clone with no env vars set behaves
 *  exactly as today, byte-for-byte. */
const LEGACY_DESCRIPTOR: WorkspaceDescriptor = {
  key: "legacy",
  kind: "admin",
  dataDir: env.dataDir,
  urlPrefix: "",
  requiresAuth: false,
};

const ADMIN_DESCRIPTOR: WorkspaceDescriptor = {
  key: "admin",
  kind: "admin",
  dataDir: env.dataDir,
  urlPrefix: "/admin",
  requiresAuth: true,
};

const DEMO_DESCRIPTOR: WorkspaceDescriptor = {
  key: "demo",
  kind: "demo",
  dataDir: path.join(env.dataDir, "workspaces", "demo"),
  urlPrefix: "/demo",
  requiresAuth: false,
};

const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/** Single source of truth for where a workbench's data lives — reused by server.ts's reset/delete handlers so the two can never drift apart. */
export function workbenchDataDir(slug: string): string {
  return path.join(env.dataDir, "workspaces", `workbench-${slug}`);
}

function workbenchDescriptor(slug: string): WorkspaceDescriptor {
  return {
    key: `workbench:${slug}`,
    kind: "workbench",
    dataDir: workbenchDataDir(slug),
    urlPrefix: `/workbench/${slug}`,
    requiresAuth: true,
  };
}

const ADMIN_PREFIX = /^\/admin(\/.*)?$/;
const DEMO_PREFIX = /^\/demo(\/.*)?$/;
const WORKBENCH_PREFIX = /^\/workbench\/([^/]+)(\/.*)?$/;

export type WorkspaceResolution =
  | { descriptor: WorkspaceDescriptor; rest: string }
  | { redirectTo: string }
  | "not-found";

/**
 * Resolves url.pathname to a workspace + the remaining path with that
 * workspace's prefix stripped. Static assets need no resolution at all —
 * they're workspace-agnostic root-absolute paths served unconditionally by
 * serveStatic() regardless of this function's outcome.
 */
export function resolveWorkspace(pathname: string): WorkspaceResolution {
  if (!env.adminPassword) {
    return { descriptor: LEGACY_DESCRIPTOR, rest: pathname };
  }

  let match = ADMIN_PREFIX.exec(pathname);
  if (match) return { descriptor: ADMIN_DESCRIPTOR, rest: match[1] ?? "/" };

  if (env.enableDemo) {
    match = DEMO_PREFIX.exec(pathname);
    if (match) return { descriptor: DEMO_DESCRIPTOR, rest: match[1] ?? "/" };
  }

  match = WORKBENCH_PREFIX.exec(pathname);
  if (match) {
    const slug = match[1]!;
    if (!SLUG_PATTERN.test(slug) || !getWorkbench(slug)) return "not-found";
    return { descriptor: workbenchDescriptor(slug), rest: match[2] ?? "/" };
  }

  if (pathname === "/") {
    return { redirectTo: rootRedirectTarget() };
  }

  return "not-found";
}

/** Where bare "/" should redirect to once workspaces are enabled — /demo if it exists, else /admin (which then serves its own login page if unauthenticated). */
export function rootRedirectTarget(): string {
  return env.enableDemo ? "/demo" : "/admin";
}

export function isWorkspacesEnabled(): boolean {
  return Boolean(env.adminPassword);
}

/** Used to scope the demo retention-purge sweep to demo's own workspace context. Undefined when demo isn't enabled. */
export function demoDescriptorIfEnabled(): WorkspaceDescriptor | undefined {
  return isWorkspacesEnabled() && env.enableDemo ? DEMO_DESCRIPTOR : undefined;
}
