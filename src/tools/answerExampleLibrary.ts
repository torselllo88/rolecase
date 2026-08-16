import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { currentDataDir } from "../config/workspaceContext.js";
import type { Tool, ToolExecutionContext } from "../types/tool.js";
import { resolveInsideDir } from "./fsSafety.js";

const ListExamplesInputSchema = z.object({});
const AnswerExampleSchema = z.object({ question: z.string(), answer: z.string() });
const ListExamplesOutputSchema = z.object({
  examples: z.array(AnswerExampleSchema),
  truncated: z.boolean(),
});

function answerExamplesDir(): string {
  return path.join(currentDataDir(), "answer-examples");
}

/** A line containing only "---" (optionally surrounded by whitespace) separates multiple Q/A pairs within one file. */
const SEPARATOR_PATTERN = /^[ \t]*---[ \t]*$/m;
const QA_PATTERN = /^Q:\s*([^\n]+)\n+A:\s*([\s\S]+)$/;

// Same order of magnitude as vacancyScraper.ts's MAX_EXTRACTED_CHARS — bounds how
// much of every Writer prompt this library can occupy, since (unlike a
// relevance-matched retrieval system, deliberately out of scope) every entry
// under the cap gets included regardless of relevance to the current question.
const MAX_TOTAL_CHARS = 20_000;

function parseQaPairs(content: string): { question: string; answer: string }[] {
  return content
    .split(SEPARATOR_PATTERN)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .flatMap((chunk) => {
      const match = chunk.match(QA_PATTERN);
      return match ? [{ question: match[1]!.trim(), answer: match[2]!.trim() }] : [];
    });
}

/**
 * Plain-text/markdown examples of the candidate's own past question->answer
 * pairs, used as few-shot grounding for the Writer agent's dynamic-question
 * answers — mirrors CoverLetterLibrary's file-reading pattern exactly,
 * including the README.md-exclusion-from-parsing fix. Populated manually
 * only: nothing in this codebase ever writes to this folder, so a rejected/
 * regenerated draft never silently becomes a future "example."
 */
export class AnswerExampleLibrary
  implements
    Tool<z.infer<typeof ListExamplesInputSchema>, z.infer<typeof ListExamplesOutputSchema>>
{
  readonly name = "answer_example_library.list_examples";
  readonly description =
    "Lists example question/answer pairs written by the candidate, for grounding new answers.";
  readonly inputSchema = ListExamplesInputSchema;
  readonly outputSchema = ListExamplesOutputSchema;

  async execute(
    _input: z.infer<typeof ListExamplesInputSchema>,
    _ctx: ToolExecutionContext
  ): Promise<z.infer<typeof ListExamplesOutputSchema>> {
    const dir = answerExamplesDir();
    if (!fs.existsSync(dir)) return { examples: [], truncated: false };

    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f));
    const allPairs = files.flatMap((f) => parseQaPairs(fs.readFileSync(path.join(dir, f), "utf-8")));

    const examples: { question: string; answer: string }[] = [];
    let totalChars = 0;
    let truncated = false;
    for (const pair of allPairs) {
      const size = pair.question.length + pair.answer.length;
      if (totalChars + size > MAX_TOTAL_CHARS) {
        // Skip just this one pair, not every pair after it — `break` here
        // used to mean a single oversized entry silently dropped every
        // remaining example in enumeration order (file-read order, which is
        // effectively arbitrary since entries are named by randomUUID()),
        // regardless of how small they were.
        truncated = true;
        continue;
      }
      examples.push(pair);
      totalChars += size;
    }

    return { examples, truncated };
  }
}

function listedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f));
}

export interface AnswerExampleEntry {
  id: string;
  question: string;
  answer: string;
  /** False for a legacy file holding more than one Q/A pair (or one the QA_PATTERN can't parse) — still shown so nothing silently disappears from the admin view, but only deletable, not editable in place. */
  editable: boolean;
}

/** Admin-panel CRUD — one entry per file for anything created here, but still surfaces (read-only) any pre-existing multi-entry file the parser above already knows how to split. */
export function listAnswerExampleEntries(): AnswerExampleEntry[] {
  const dir = answerExamplesDir();
  return listedFiles(dir).map((fileName) => {
    const id = fileName.replace(/\.(md|txt)$/i, "");
    const content = fs.readFileSync(path.join(dir, fileName), "utf-8");
    const pairs = parseQaPairs(content);
    if (pairs.length === 1) {
      return { id, question: pairs[0]!.question, answer: pairs[0]!.answer, editable: true };
    }
    return {
      id,
      question: `(legacy file with ${pairs.length} entr${pairs.length === 1 ? "y" : "ies"} — edit ${fileName} directly)`,
      answer: content,
      editable: false,
    };
  });
}

function writeEntryFile(filePath: string, question: string, answer: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `Q: ${question}\nA: ${answer}\n`, "utf-8");
}

function findEntryPath(dir: string, id: string): string | undefined {
  for (const ext of [".md", ".txt"]) {
    const filePath = resolveInsideDir(dir, `${id}${ext}`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return undefined;
}

export function createAnswerExampleEntry(input: { question: string; answer: string }): string {
  const id = randomUUID();
  writeEntryFile(resolveInsideDir(answerExamplesDir(), `${id}.md`), input.question, input.answer);
  return id;
}

/** Returns false if no entry with this id exists — same "silent no-op vs missing" distinction DELETE routes use elsewhere in this codebase. */
export function updateAnswerExampleEntry(id: string, input: { question: string; answer: string }): boolean {
  const dir = answerExamplesDir();
  const filePath = findEntryPath(dir, id);
  if (!filePath) return false;
  writeEntryFile(filePath, input.question, input.answer);
  return true;
}

export function deleteAnswerExampleEntry(id: string): boolean {
  const dir = answerExamplesDir();
  const filePath = findEntryPath(dir, id);
  if (!filePath) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}
