import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AnswerExampleLibrary,
  createAnswerExampleEntry,
  deleteAnswerExampleEntry,
  listAnswerExampleEntries,
  updateAnswerExampleEntry,
} from "../../src/tools/answerExampleLibrary.js";
import { env } from "../../src/config/env.js";

function dir(): string {
  return path.join(env.dataDir, "answer-examples");
}

describe("AnswerExampleLibrary", () => {
  beforeEach(() => {
    fs.mkdirSync(dir(), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir(), { recursive: true, force: true });
  });

  it("returns an empty result when the folder doesn't exist", async () => {
    fs.rmSync(dir(), { recursive: true, force: true });
    const library = new AnswerExampleLibrary();
    const result = await library.execute({}, {});
    expect(result).toEqual({ examples: [], truncated: false });
  });

  it("parses multiple Q/A pairs from one file, separated by a lone --- line", async () => {
    fs.writeFileSync(
      path.join(dir(), "examples.md"),
      "Q: Why do you want to work here?\nA: I love the mission.\n\n---\n\nQ: Describe a challenge.\nA: I once fixed a hard bug."
    );

    const library = new AnswerExampleLibrary();
    const result = await library.execute({}, {});

    expect(result.truncated).toBe(false);
    expect(result.examples).toEqual([
      { question: "Why do you want to work here?", answer: "I love the mission." },
      { question: "Describe a challenge.", answer: "I once fixed a hard bug." },
    ]);
  });

  it("excludes README.md from parsing", async () => {
    fs.writeFileSync(path.join(dir(), "README.md"), "Q: Not a real example\nA: Should be ignored");
    fs.writeFileSync(path.join(dir(), "real.md"), "Q: Real question\nA: Real answer");

    const library = new AnswerExampleLibrary();
    const result = await library.execute({}, {});

    expect(result.examples).toEqual([{ question: "Real question", answer: "Real answer" }]);
  });

  it("caps total included characters and reports truncation rather than silently dropping entries", async () => {
    const bigAnswer = "x".repeat(15_000);
    fs.writeFileSync(path.join(dir(), "a.md"), `Q: First?\nA: ${bigAnswer}`);
    fs.writeFileSync(path.join(dir(), "b.md"), `Q: Second?\nA: ${bigAnswer}`);

    const library = new AnswerExampleLibrary();
    const result = await library.execute({}, {});

    expect(result.examples).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  describe("admin CRUD helpers", () => {
    it("creates, lists, updates, and deletes a single-entry file", () => {
      const id = createAnswerExampleEntry({ question: "Why this role?", answer: "Because it fits." });

      let entries = listAnswerExampleEntries();
      expect(entries).toEqual([{ id, question: "Why this role?", answer: "Because it fits.", editable: true }]);

      expect(updateAnswerExampleEntry(id, { question: "Why this role, really?", answer: "Updated answer." })).toBe(
        true
      );
      entries = listAnswerExampleEntries();
      expect(entries[0]).toEqual({
        id,
        question: "Why this role, really?",
        answer: "Updated answer.",
        editable: true,
      });

      expect(deleteAnswerExampleEntry(id)).toBe(true);
      expect(listAnswerExampleEntries()).toEqual([]);
    });

    it("returns false from update/delete for an id that doesn't exist", () => {
      expect(updateAnswerExampleEntry("not-a-real-id", { question: "Q", answer: "A" })).toBe(false);
      expect(deleteAnswerExampleEntry("not-a-real-id")).toBe(false);
    });

    it("surfaces a legacy multi-entry file as read-only rather than hiding it", () => {
      fs.writeFileSync(
        path.join(dir(), "legacy.md"),
        "Q: One?\nA: First.\n\n---\n\nQ: Two?\nA: Second."
      );

      const entries = listAnswerExampleEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe("legacy");
      expect(entries[0]!.editable).toBe(false);
    });

    it("rejects an id that attempts to escape the answer-examples directory", () => {
      expect(() => updateAnswerExampleEntry("../../etc/passwd", { question: "Q", answer: "A" })).toThrow(
        /invalid file name/i
      );
    });
  });
});
