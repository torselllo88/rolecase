import { describe, expect, it } from "vitest";
import {
  hashWorkbenchPassword,
  verifyAdminPassword,
  verifyWorkbenchPassword,
} from "../../../src/gui/auth/password.js";

describe("verifyAdminPassword", () => {
  it("accepts the exact matching password", () => {
    expect(verifyAdminPassword("correct-password", "correct-password")).toBe(true);
  });

  it("rejects a wrong password of the same length", () => {
    expect(verifyAdminPassword("wrong-password", "correct-passw0rd")).toBe(false);
  });

  it("rejects a wrong password of a different (shorter) length", () => {
    expect(verifyAdminPassword("short", "a-much-longer-correct-password")).toBe(false);
  });

  it("rejects a wrong password of a different (longer) length", () => {
    expect(verifyAdminPassword("a-much-longer-wrong-password", "short")).toBe(false);
  });

  it("rejects an empty submitted password against a non-empty expected one", () => {
    expect(verifyAdminPassword("", "correct-password")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(verifyAdminPassword("Correct-Password", "correct-password")).toBe(false);
  });
});

describe("hashWorkbenchPassword / verifyWorkbenchPassword", () => {
  it("round-trips: a password hashed then verified against its own hash succeeds", () => {
    const { saltHex, hashHex } = hashWorkbenchPassword("alex-secret-pw");
    expect(verifyWorkbenchPassword("alex-secret-pw", saltHex, hashHex)).toBe(true);
  });

  it("rejects a wrong password against a real hash", () => {
    const { saltHex, hashHex } = hashWorkbenchPassword("alex-secret-pw");
    expect(verifyWorkbenchPassword("wrong-guess", saltHex, hashHex)).toBe(false);
  });

  it("produces a different salt (and hash) on every call, even for the same password", () => {
    const first = hashWorkbenchPassword("same-password");
    const second = hashWorkbenchPassword("same-password");
    expect(first.saltHex).not.toBe(second.saltHex);
    expect(first.hashHex).not.toBe(second.hashHex);
    // Both still independently verify correctly despite differing.
    expect(verifyWorkbenchPassword("same-password", first.saltHex, first.hashHex)).toBe(true);
    expect(verifyWorkbenchPassword("same-password", second.saltHex, second.hashHex)).toBe(true);
  });

  it("does not verify one workbench's password against another's salt/hash", () => {
    const alex = hashWorkbenchPassword("alex-pw");
    const dana = hashWorkbenchPassword("dana-pw");
    expect(verifyWorkbenchPassword("alex-pw", dana.saltHex, dana.hashHex)).toBe(false);
    expect(verifyWorkbenchPassword("dana-pw", alex.saltHex, alex.hashHex)).toBe(false);
  });
});
