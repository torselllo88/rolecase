import { randomBytes } from "node:crypto";
import type { WorkspaceKind } from "../../config/workspaceContext.js";

interface Session {
  workspaceKey: string;
  kind: WorkspaceKind;
  expiresAt: number;
}

/**
 * One shape, in-memory, serves both password-gated sessions (admin/workbench,
 * minted only after a correct password) and demo's anonymous no-password
 * session (auto-issued on first /demo hit) — no duplicate infrastructure.
 * Fine at this traffic scale; no Redis needed.
 */
const sessions = new Map<string, Session>();

let sweepTimer: ReturnType<typeof setInterval> | undefined;

function ensureSweepScheduled(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }, 10 * 60_000);
  sweepTimer.unref?.();
}

export function createSession(workspaceKey: string, kind: WorkspaceKind, ttlMs: number): string {
  ensureSweepScheduled();
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { workspaceKey, kind, expiresAt: Date.now() + ttlMs });
  return token;
}

export function getSession(token: string | undefined): Session | undefined {
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

/** Used when a workbench's password is rotated — without this, a browser already
 *  logged in under the OLD password keeps full access until its session naturally
 *  expires, regardless of the password change. */
export function destroySessionsForWorkspace(workspaceKey: string): void {
  for (const [token, session] of sessions) {
    if (session.workspaceKey === workspaceKey) sessions.delete(token);
  }
}
