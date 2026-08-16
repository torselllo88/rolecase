import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoverLetterLibrary,
  createCoverLetterEntry,
  deleteCoverLetterEntry,
  listCoverLetterEntries,
  updateCoverLetterEntry,
} from "../../src/tools/coverLetterLibrary.js";
import { env } from "../../src/config/env.js";

function dir(): string {
  return path.join(env.dataDir, "cover-letters");
}

describe("CoverLetterLibrary", () => {
  beforeEach(() => {
    fs.mkdirSync(dir(), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir(), { recursive: true, force: true });
  });

  it("returns an empty result when the folder doesn't exist", async () => {
    fs.rmSync(dir(), { recursive: true, force: true });
    const library = new CoverLetterLibrary();
    const result = await library.execute({}, {});
    expect(result).toEqual({ examples: [], truncated: false });
  });

  it("splits multiple examples in one file on a lone --- line", async () => {
    fs.writeFileSync(path.join(dir(), "letters.md"), "Dear Team,\nFirst letter.\n\n---\n\nDear Team,\nSecond letter.");

    const library = new CoverLetterLibrary();
    const result = await library.execute({}, {});

    expect(result.truncated).toBe(false);
    expect(result.examples).toEqual(["Dear Team,\nFirst letter.", "Dear Team,\nSecond letter."]);
  });

  it("caps total included characters and skips only the oversized entry, not every one after it", async () => {
    const bigLetter = "x".repeat(15_000);
    fs.writeFileSync(path.join(dir(), "a.md"), bigLetter);
    fs.writeFileSync(path.join(dir(), "b.md"), bigLetter);
    fs.writeFileSync(path.join(dir(), "c.md"), "A short one that should still get through.");

    const library = new CoverLetterLibrary();
    const result = await library.execute({}, {});

    expect(result.truncated).toBe(true);
    expect(result.examples).toContain("A short one that should still get through.");
    expect(result.examples).toHaveLength(2); // one big one fits under the cap, the second doesn't — the short one after it still does
  });

  describe("admin CRUD helpers", () => {
    it("creates, lists, updates, and deletes a single-entry file", () => {
      const id = createCoverLetterEntry("Dear Hiring Team,\nI'm excited to apply.");

      let entries = listCoverLetterEntries();
      expect(entries).toEqual([{ id, text: "Dear Hiring Team,\nI'm excited to apply.", editable: true }]);

      expect(updateCoverLetterEntry(id, "Dear Hiring Team,\nUpdated text.")).toBe(true);
      entries = listCoverLetterEntries();
      expect(entries[0]).toEqual({ id, text: "Dear Hiring Team,\nUpdated text.", editable: true });

      expect(deleteCoverLetterEntry(id)).toBe(true);
      expect(listCoverLetterEntries()).toEqual([]);
    });

    it("returns false from update/delete for an id that doesn't exist", () => {
      expect(updateCoverLetterEntry("not-a-real-id", "text")).toBe(false);
      expect(deleteCoverLetterEntry("not-a-real-id")).toBe(false);
    });

    it("surfaces a legacy multi-entry file as read-only rather than hiding it", () => {
      fs.writeFileSync(path.join(dir(), "legacy.md"), "First.\n\n---\n\nSecond.");

      const entries = listCoverLetterEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe("legacy");
      expect(entries[0]!.editable).toBe(false);
    });
  });
});
