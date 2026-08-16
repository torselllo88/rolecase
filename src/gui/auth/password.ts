import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Deliberately NOT hashed: ADMIN_PASSWORD already lives in plaintext in
 * .env — hashing it with an in-memory salt at boot would add scrypt's CPU
 * cost to every login with zero real security benefit (nothing is persisted
 * for an attacker to dictionary-attack offline; the only copy is the same
 * plaintext env var). A plain constant-time comparison is the right tool
 * here. Buffers are length-equalized first so a length mismatch can't
 * short-circuit the comparison and leak timing information.
 */
export function verifyAdminPassword(submitted: string, expected: string): boolean {
  const submittedBuf = Buffer.from(submitted, "utf-8");
  const expectedBuf = Buffer.from(expected, "utf-8");
  const len = Math.max(submittedBuf.length, expectedBuf.length, 1);
  const a = Buffer.alloc(len);
  const b = Buffer.alloc(len);
  submittedBuf.copy(a);
  expectedBuf.copy(b);
  // timingSafeEqual must run unconditionally — the length check is combined
  // AFTER, not with `&&` (which would short-circuit and skip the constant-time
  // comparison whenever lengths differ, leaking ADMIN_PASSWORD's exact byte
  // length through response timing, defeating the whole point of padding a/b).
  const lengthsMatch = submittedBuf.length === expectedBuf.length;
  const contentsMatch = timingSafeEqual(a, b);
  return lengthsMatch && contentsMatch;
}

/**
 * Workbench passwords ARE persisted (the `workspaces` registry table, Phase
 * 4) — a salted hash means a DB file leak doesn't hand out plaintext
 * passwords, unlike ADMIN_PASSWORD above which has no such persisted copy.
 */
export function hashWorkbenchPassword(password: string): { saltHex: string; hashHex: string } {
  const salt = randomBytes(16);
  return { saltHex: salt.toString("hex"), hashHex: scryptSync(password, salt, 64).toString("hex") };
}

export function verifyWorkbenchPassword(submitted: string, saltHex: string, hashHex: string): boolean {
  const candidate = scryptSync(submitted, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
