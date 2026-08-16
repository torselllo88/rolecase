import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { currentDataDir } from "../config/workspaceContext.js";
import type { Tool, ToolExecutionContext } from "../types/tool.js";
import { resolveInsideDir } from "./fsSafety.js";

const ListExamplesInputSchema = z.object({});
const ListExamplesOutputSchema = z.object({ examples: z.array(z.string()), truncated: z.boolean() });

function coverLettersDir(): string {
  return path.join(currentDataDir(), "cover-letters");
}

/** A line containing only "---" (optionally surrounded by whitespace) separates multiple examples within one file. */
const SEPARATOR_PATTERN = /^[ \t]*---[ \t]*$/m;

// Same cap/reasoning as answerExampleLibrary.ts's MAX_TOTAL_CHARS — without
// one, a single huge cover-letter example could unboundedly inflate every
// Writer prompt, since every example under the cap is always included
// regardless of relevance (no retrieval/ranking, deliberately out of scope).
const MAX_TOTAL_CHARS = 20_000;

function splitIntoExamples(content: string): string[] {
  return content
    .split(SEPARATOR_PATTERN)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/**
 * Plain-text/markdown examples of the candidate's own past cover letters,
 * used as few-shot style/voice grounding for the Writer agent — no parsing
 * needed since these aren't PDFs. Supports either one file per letter, or
 * several letters in one file separated by a lone "---" line (or a mix of
 * both across the folder).
 */
export class CoverLetterLibrary
  implements
    Tool<z.infer<typeof ListExamplesInputSchema>, z.infer<typeof ListExamplesOutputSchema>>
{
  readonly name = "cover_letter_library.list_examples";
  readonly description =
    "Lists example cover letters written by the candidate, for style/voice reference.";
  readonly inputSchema = ListExamplesInputSchema;
  readonly outputSchema = ListExamplesOutputSchema;

  async execute(
    _input: z.infer<typeof ListExamplesInputSchema>,
    _ctx: ToolExecutionContext
  ): Promise<z.infer<typeof ListExamplesOutputSchema>> {
    const dir = coverLettersDir();
    if (!fs.existsSync(dir)) return { examples: [], truncated: false };

    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f));
    const allExamples = files.flatMap((f) => splitIntoExamples(fs.readFileSync(path.join(dir, f), "utf-8")));

    const examples: string[] = [];
    let totalChars = 0;
    let truncated = false;
    for (const example of allExamples) {
      if (totalChars + example.length > MAX_TOTAL_CHARS) {
        truncated = true; // Skip just this one oversized example, not every one after it.
        continue;
      }
      examples.push(example);
      totalChars += example.length;
    }

    return { examples, truncated };
  }
}

export interface CoverLetterEntry {
  id: string;
  text: string;
  /** False for a legacy file holding more than one example separated by "---" — still shown, only deletable in the admin UI, not editable in place. */
  editable: boolean;
}

function listedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f));
}

/** Admin-panel CRUD — same one-entry-per-file convention as answerExampleLibrary.ts. */
export function listCoverLetterEntries(): CoverLetterEntry[] {
  const dir = coverLettersDir();
  return listedFiles(dir).map((fileName) => {
    const id = fileName.replace(/\.(md|txt)$/i, "");
    const content = fs.readFileSync(path.join(dir, fileName), "utf-8");
    const pieces = splitIntoExamples(content);
    return pieces.length === 1
      ? { id, text: pieces[0]!, editable: true }
      : { id, text: content, editable: false };
  });
}

function findEntryPath(dir: string, id: string): string | undefined {
  for (const ext of [".md", ".txt"]) {
    const filePath = resolveInsideDir(dir, `${id}${ext}`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return undefined;
}

export function createCoverLetterEntry(text: string): string {
  const id = randomUUID();
  const filePath = resolveInsideDir(coverLettersDir(), `${id}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${text.trim()}\n`, "utf-8");
  return id;
}

export function updateCoverLetterEntry(id: string, text: string): boolean {
  const filePath = findEntryPath(coverLettersDir(), id);
  if (!filePath) return false;
  fs.writeFileSync(filePath, `${text.trim()}\n`, "utf-8");
  return true;
}

export function deleteCoverLetterEntry(id: string): boolean {
  const filePath = findEntryPath(coverLettersDir(), id);
  if (!filePath) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}
