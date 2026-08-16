import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { currentDataDir } from "../config/workspaceContext.js";
import type { Tool, ToolExecutionContext } from "../types/tool.js";
import { resolveInsideDir } from "./fsSafety.js";

const ListNotesInputSchema = z.object({});
const ListNotesOutputSchema = z.object({ notes: z.array(z.string()), truncated: z.boolean() });

function candidateNotesDir(): string {
  return path.join(currentDataDir(), "candidate-notes");
}

/** A line containing only "---" (optionally surrounded by whitespace) separates multiple notes within one file. */
const SEPARATOR_PATTERN = /^[ \t]*---[ \t]*$/m;

// Same cap/reasoning as answerExampleLibrary.ts's/coverLetterLibrary.ts's MAX_TOTAL_CHARS.
const MAX_TOTAL_CHARS = 20_000;

function splitIntoNotes(content: string): string[] {
  return content
    .split(SEPARATOR_PATTERN)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/**
 * Free-form background info about the candidate (self/projects) that doesn't
 * fit as a resume or a Q&A pair — additional grounding for the Writer and
 * Evidence Checker, and for the vacancy-analyzer's fit scoring (see
 * orchestrator.ts's buildCandidateProfileText/buildGroundingText). Supports
 * either one file per note, or several notes in one file separated by a lone
 * "---" line (or a mix of both across the folder), same as CoverLetterLibrary.
 */
export class CandidateNotesLibrary
  implements Tool<z.infer<typeof ListNotesInputSchema>, z.infer<typeof ListNotesOutputSchema>>
{
  readonly name = "candidate_notes_library.list_notes";
  readonly description =
    "Lists free-form background notes about the candidate (self/projects) beyond their resume.";
  readonly inputSchema = ListNotesInputSchema;
  readonly outputSchema = ListNotesOutputSchema;

  async execute(
    _input: z.infer<typeof ListNotesInputSchema>,
    _ctx: ToolExecutionContext
  ): Promise<z.infer<typeof ListNotesOutputSchema>> {
    const dir = candidateNotesDir();
    if (!fs.existsSync(dir)) return { notes: [], truncated: false };

    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f));
    const allNotes = files.flatMap((f) => splitIntoNotes(fs.readFileSync(path.join(dir, f), "utf-8")));

    const notes: string[] = [];
    let totalChars = 0;
    let truncated = false;
    for (const note of allNotes) {
      if (totalChars + note.length > MAX_TOTAL_CHARS) {
        truncated = true; // Skip just this one oversized note, not every one after it.
        continue;
      }
      notes.push(note);
      totalChars += note.length;
    }

    return { notes, truncated };
  }
}

export interface CandidateNoteEntry {
  id: string;
  text: string;
  /** False for a legacy file holding more than one note separated by "---" — still shown, only deletable in the admin UI, not editable in place. */
  editable: boolean;
}

function listedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f));
}

/** Admin-panel CRUD — same one-entry-per-file convention as answerExampleLibrary.ts/coverLetterLibrary.ts. */
export function listCandidateNoteEntries(): CandidateNoteEntry[] {
  const dir = candidateNotesDir();
  return listedFiles(dir).map((fileName) => {
    const id = fileName.replace(/\.(md|txt)$/i, "");
    const content = fs.readFileSync(path.join(dir, fileName), "utf-8");
    const pieces = splitIntoNotes(content);
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

export function createCandidateNoteEntry(text: string): string {
  const id = randomUUID();
  const filePath = resolveInsideDir(candidateNotesDir(), `${id}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${text.trim()}\n`, "utf-8");
  return id;
}

export function updateCandidateNoteEntry(id: string, text: string): boolean {
  const filePath = findEntryPath(candidateNotesDir(), id);
  if (!filePath) return false;
  fs.writeFileSync(filePath, `${text.trim()}\n`, "utf-8");
  return true;
}

export function deleteCandidateNoteEntry(id: string): boolean {
  const filePath = findEntryPath(candidateNotesDir(), id);
  if (!filePath) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}
