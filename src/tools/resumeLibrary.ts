import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import { currentDataDir } from "../config/workspaceContext.js";
import { estimateCostUsd } from "../llm/pricing.js";
import type { LlmProvider } from "../llm/provider.js";
import type { Tool, ToolExecutionContext } from "../types/tool.js";
import { resolveInsideDir } from "./fsSafety.js";

export const ResumeCandidateSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  text: z.string(),
});
export type ResumeCandidate = z.infer<typeof ResumeCandidateSchema>;

const ListResumesInputSchema = z.object({});
const ListResumesOutputSchema = z.object({ resumes: z.array(ResumeCandidateSchema) });

const NORMALIZE_SYSTEM_PROMPT =
  "You clean up resume text extracted from a PDF. PDF text extraction can scramble reading " +
  "order (multi-column layouts, tables, headers/footers). Reconstruct the resume as clean, " +
  "ordinary reading-order plain text — name, then sections (experience, skills, education, " +
  "etc.) in a sensible order. Do not summarize, omit, or invent content; only reorder and fix " +
  "obviously broken line breaks and whitespace. Preserve every fact, number, and date exactly.";

function resumesDir(): string {
  return path.join(currentDataDir(), "resumes");
}

function cacheDir(): string {
  return path.join(resumesDir(), ".cache");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Matches README's planned "Resume Library" MCP server — a Tool today, a thin
 * adapter over the same execute() later. PDF text extraction can scramble
 * reading order for multi-column/table layouts; rather than fighting PDF
 * internals directly, an optional LLM cleanup pass reorders it — cached to
 * disk by content hash, so a given resume is only ever normalized (and only
 * ever costs tokens) once, until its PDF file actually changes.
 */
export class ResumeLibrary
  implements Tool<z.infer<typeof ListResumesInputSchema>, z.infer<typeof ListResumesOutputSchema>>
{
  readonly name = "resume_library.list_resumes";
  readonly description =
    "Lists all PDF resumes in the Resume Library with their extracted, cleaned-up text.";
  readonly inputSchema = ListResumesInputSchema;
  readonly outputSchema = ListResumesOutputSchema;

  constructor(private readonly llm?: LlmProvider) {}

  async execute(
    _input: z.infer<typeof ListResumesInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<z.infer<typeof ListResumesOutputSchema>> {
    const dir = resumesDir();
    if (!fs.existsSync(dir)) return { resumes: [] };

    const allFiles = fs.readdirSync(dir);
    const resumes: ResumeCandidate[] = [];

    for (const fileName of allFiles.filter((f) => f.toLowerCase().endsWith(".pdf"))) {
      const buffer = await readFile(path.join(dir, fileName));
      const parser = new PDFParse({ data: buffer });
      let rawText: string;
      try {
        rawText = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }

      const text = await this.normalizeText(rawText, ctx.tracer);
      resumes.push({ id: fileName.replace(/\.pdf$/i, ""), fileName, text });
    }

    // Pasted-text resumes need no PDF extraction and no reading-order cleanup
    // pass — they're already clean, human-typed text. .md is deliberately not
    // included here: the resumes folder ships its own README.md documenting
    // the folder, and treating .md as a resume format would sweep it in as a
    // fake candidate.
    for (const fileName of allFiles.filter((f) => /\.txt$/i.test(f))) {
      const text = fs.readFileSync(path.join(dir, fileName), "utf-8").trim();
      if (text) resumes.push({ id: fileName.replace(/\.txt$/i, ""), fileName, text });
    }

    return { resumes };
  }

  private async normalizeText(rawText: string, tracer?: ToolExecutionContext["tracer"]): Promise<string> {
    if (!this.llm) return rawText;

    const hash = hashContent(rawText);
    const cachePath = path.join(cacheDir(), `${hash}.txt`);
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath, "utf-8");
    }

    const startedAt = new Date().toISOString();
    const result = await this.llm.generateStructured({
      consumer: "RESUME_LIBRARY",
      schemaName: "NormalizedResumeText",
      schema: z.object({ text: z.string() }),
      systemPrompt: NORMALIZE_SYSTEM_PROMPT,
      userPrompt: rawText,
    });

    tracer?.recordModelCall({
      agentName: "RESUME_LIBRARY",
      model: result.model,
      tokenUsage: result.tokenUsage,
      estimatedCostUsd: estimateCostUsd(result.model, result.tokenUsage),
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePath, result.data.text, "utf-8");
    return result.data.text;
  }
}

export interface ResumeFileMeta {
  id: string;
  fileName: string;
  sizeBytes: number;
  uploadedAt: string;
  /** "text" entries are edited in place from the admin UI; "pdf" ones can only be replaced/deleted. */
  type: "pdf" | "text";
  /** Only present for `type: "text"` — a text resume is cheap to read in full for the admin list (no PDF parsing), so the edit form always has real content to start from instead of a blank textarea. */
  text?: string;
}

/** Admin-panel CRUD helpers — separate from the Tool above (which agents use for grounding), since managing the files themselves is a GUI-only concern. */
export function listResumeFiles(): ResumeFileMeta[] {
  const dir = resumesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(pdf|txt)$/i.test(f))
    .map((fileName) => {
      const stat = fs.statSync(path.join(dir, fileName));
      const isPdf = /\.pdf$/i.test(fileName);
      return {
        id: fileName.replace(/\.(pdf|txt)$/i, ""),
        fileName,
        sizeBytes: stat.size,
        uploadedAt: stat.mtime.toISOString(),
        type: isPdf ? "pdf" : "text",
        text: isPdf ? undefined : fs.readFileSync(path.join(dir, fileName), "utf-8"),
      };
    });
}

/** Every real PDF starts with this signature (optionally after a few junk bytes some generators prepend) — catches a non-PDF file uploaded with a spoofed ".pdf" name, which the extension check alone can't. */
const PDF_MAGIC_BYTES = Buffer.from("%PDF-");

function looksLikePdf(data: Buffer): boolean {
  return data.subarray(0, 1024).includes(PDF_MAGIC_BYTES);
}

/** Returns the new resume's id (filename minus extension). Throws on a non-PDF upload (wrong extension, or content that doesn't actually start with a PDF signature). */
export function saveResumeFile(fileName: string, data: Buffer): string {
  const safeName = path.basename(fileName);
  if (!safeName.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only .pdf files can be uploaded to the Resume Library.");
  }
  if (!looksLikePdf(data)) {
    throw new Error("This file's content doesn't look like a real PDF (missing the %PDF- signature).");
  }
  const dir = resumesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolveInsideDir(dir, safeName), data);
  return safeName.replace(/\.pdf$/i, "");
}

/** Only letters/numbers/spaces/hyphens/underscores survive — this becomes part of a filesystem path (still checked by resolveInsideDir below regardless). */
function sanitizeResumeName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80);
  return cleaned || `resume-${randomUUID().slice(0, 8)}`;
}

function findResumeTextPath(dir: string, id: string): string | undefined {
  const filePath = resolveInsideDir(dir, `${id}.txt`);
  return fs.existsSync(filePath) ? filePath : undefined;
}

/**
 * Returns the new resume's id (its sanitized name — same "filename minus
 * extension" convention as a PDF upload). Throws on blank text or a
 * name collision, rather than silently overwriting a differently-created
 * resume that happens to sanitize to the same name.
 */
export function createResumeTextEntry(name: string, text: string): string {
  if (!text.trim()) throw new Error("Resume text cannot be empty.");
  const safeName = sanitizeResumeName(name);
  const dir = resumesDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = resolveInsideDir(dir, `${safeName}.txt`);
  if (fs.existsSync(filePath) || fs.existsSync(resolveInsideDir(dir, `${safeName}.pdf`))) {
    throw new Error(`A resume named "${safeName}" already exists — choose a different name.`);
  }
  fs.writeFileSync(filePath, text.trim(), "utf-8");
  return safeName;
}

/** Returns false if no TEXT resume with this id exists — a PDF entry is never editable this way (see ResumeFileMeta.type). */
export function updateResumeTextEntry(id: string, text: string): boolean {
  if (!text.trim()) throw new Error("Resume text cannot be empty.");
  const filePath = findResumeTextPath(resumesDir(), id);
  if (!filePath) return false;
  fs.writeFileSync(filePath, text.trim(), "utf-8");
  return true;
}

/** Returns false if no resume (PDF or text) with this id exists — a PDF's .cache/ entry for its content hash is left as a harmless orphan. */
export function deleteResumeFile(id: string): boolean {
  for (const ext of [".pdf", ".txt"]) {
    const filePath = resolveInsideDir(resumesDir(), `${id}${ext}`);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      return true;
    }
  }
  return false;
}
