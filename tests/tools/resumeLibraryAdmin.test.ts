import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createResumeTextEntry,
  deleteResumeFile,
  listResumeFiles,
  saveResumeFile,
  updateResumeTextEntry,
} from "../../src/tools/resumeLibrary.js";
import { env } from "../../src/config/env.js";

function dir(): string {
  return path.join(env.dataDir, "resumes");
}

// Only the admin CRUD helpers — the Tool class's PDF-parsing/LLM-cleanup path
// is covered separately (or manually, since it needs a real PDF fixture).
describe("resumeLibrary admin CRUD helpers", () => {
  beforeEach(() => {
    fs.mkdirSync(dir(), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir(), { recursive: true, force: true });
  });

  it("returns an empty list when the folder doesn't exist", () => {
    fs.rmSync(dir(), { recursive: true, force: true });
    expect(listResumeFiles()).toEqual([]);
  });

  it("saves a PDF upload and lists it with size/upload-time metadata", () => {
    const id = saveResumeFile("My Resume.pdf", Buffer.from("%PDF-1.4 fake content"));
    expect(id).toBe("My Resume");

    const files = listResumeFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("My Resume");
    expect(files[0]!.fileName).toBe("My Resume.pdf");
    expect(files[0]!.sizeBytes).toBeGreaterThan(0);
    expect(new Date(files[0]!.uploadedAt).getTime()).not.toBeNaN();
    expect(files[0]!.type).toBe("pdf");
    expect(files[0]!.text).toBeUndefined();
  });

  it("refuses a non-PDF upload by extension", () => {
    expect(() => saveResumeFile("resume.txt", Buffer.from("not a pdf"))).toThrow(/only \.pdf/i);
  });

  it("refuses a .pdf-named file whose content isn't actually a PDF", () => {
    expect(() => saveResumeFile("resume.pdf", Buffer.from("just some text, not a real PDF"))).toThrow(
      /doesn't look like a real pdf/i
    );
    expect(listResumeFiles()).toEqual([]);
  });

  it("deletes an uploaded resume by id and reports false for an unknown id", () => {
    saveResumeFile("Resume.pdf", Buffer.from("%PDF-1.4 fake content"));

    expect(deleteResumeFile("Resume")).toBe(true);
    expect(listResumeFiles()).toEqual([]);
    expect(deleteResumeFile("Resume")).toBe(false);
  });

  it("rejects a path-traversal attempt in the uploaded file name", () => {
    expect(() => saveResumeFile("../../evil.pdf", Buffer.from("%PDF-1.4"))).not.toThrow();
    // path.basename() strips the traversal — it lands inside the resumes dir as "evil.pdf", not outside it.
    expect(listResumeFiles().map((f) => f.fileName)).toEqual(["evil.pdf"]);
  });

  it("rejects a delete id that attempts to escape the resumes directory", () => {
    expect(() => deleteResumeFile("../../etc/passwd")).toThrow(/invalid file name/i);
  });

  it("creates a pasted-text resume and lists it with its text and a text type", () => {
    const id = createResumeTextEntry("Backend-focused", "Experienced backend engineer.");
    expect(id).toBe("Backend-focused");

    const files = listResumeFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("Backend-focused");
    expect(files[0]!.fileName).toBe("Backend-focused.txt");
    expect(files[0]!.type).toBe("text");
    expect(files[0]!.text).toBe("Experienced backend engineer.");
  });

  it("rejects creating a text resume with blank text", () => {
    expect(() => createResumeTextEntry("Blank", "   ")).toThrow(/cannot be empty/i);
    expect(listResumeFiles()).toEqual([]);
  });

  it("rejects creating a text resume whose sanitized name collides with an existing text or PDF resume", () => {
    createResumeTextEntry("Backend-focused", "Some text.");
    expect(() => createResumeTextEntry("Backend-focused", "Other text.")).toThrow(/already exists/i);

    saveResumeFile("Frontend.pdf", Buffer.from("%PDF-1.4 fake content"));
    expect(() => createResumeTextEntry("Frontend", "Some text.")).toThrow(/already exists/i);
  });

  it("updates an existing text resume's content and reports false for an unknown id", () => {
    createResumeTextEntry("Backend-focused", "Original text.");
    expect(updateResumeTextEntry("Backend-focused", "Updated text.")).toBe(true);
    expect(listResumeFiles()[0]!.text).toBe("Updated text.");

    expect(updateResumeTextEntry("does-not-exist", "Whatever.")).toBe(false);
  });

  it("does not let updateResumeTextEntry touch a PDF entry", () => {
    saveResumeFile("Resume.pdf", Buffer.from("%PDF-1.4 fake content"));
    expect(updateResumeTextEntry("Resume", "Sneaky replacement text.")).toBe(false);
  });

  it("rejects updating a text resume with blank text", () => {
    createResumeTextEntry("Backend-focused", "Original text.");
    expect(() => updateResumeTextEntry("Backend-focused", "  ")).toThrow(/cannot be empty/i);
  });

  it("rejects an update id that attempts to escape the resumes directory", () => {
    expect(() => updateResumeTextEntry("../../etc/passwd", "text")).toThrow(/invalid file name/i);
  });

  it("deletes a pasted-text resume by id", () => {
    createResumeTextEntry("Backend-focused", "Some text.");
    expect(deleteResumeFile("Backend-focused")).toBe(true);
    expect(listResumeFiles()).toEqual([]);
  });
});
