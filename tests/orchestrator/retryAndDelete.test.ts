import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config/env.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { RunRepository } from "../../src/persistence/runRepository.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { WorkflowState } from "../../src/types/workflow.js";

const { extractContentMock } = vi.hoisted(() => ({
  extractContentMock: vi.fn(async () => ({ rawText: "Senior Engineer at Acme\nGreat role." })),
}));

vi.mock("../../src/tools/vacancyScraper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/vacancyScraper.js")>();
  return {
    ...actual,
    extractContentTool: { ...actual.extractContentTool, execute: extractContentMock },
  };
});

function runDir(runId: string): string {
  return path.join(env.dataDir, "runs", runId);
}

describe("Orchestrator.retryAnalysis / deleteRun", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;
  let runRepo: RunRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
    runRepo = new RunRepository(db);
    extractContentMock.mockClear();
  });

  it("resets a processed run to CREATED, clears prior artifacts, and re-analyzes", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Senior Engineer at Acme" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);
    await orchestrator.generate(run.id);
    expect(fs.existsSync(path.join(runDir(run.id), "application-package"))).toBe(true);

    const result = await orchestrator.retryAnalysis(run.id);

    expect(result.run.state).toBe(WorkflowState.ANALYSIS_READY);
    expect(result.run.packageIterationCount).toBe(0);
    expect(fs.existsSync(path.join(runDir(run.id), "application-package"))).toBe(false);
    expect(fs.existsSync(path.join(runDir(run.id), "vacancy-report.json"))).toBe(true);
  });

  it(
    "applies a source override before re-analyzing",
    async () => {
      const run = orchestrator.createRun({ sourceType: "raw_text", source: "Old vacancy text" });
      await orchestrator.analyze(run.id);

      const result = await orchestrator.retryAnalysis(run.id, {
        sourceType: "raw_text",
        source: "New vacancy text about a Staff Engineer role",
      });

      expect(result.run.state).toBe(WorkflowState.ANALYSIS_READY);
      expect(orchestrator.getRun(run.id).vacancySource).toBe("New vacancy text about a Staff Engineer role");
    },
    // The "Staff Engineer" title triggers an extra seniority-tier salary search in
    // CompanyResearchAgent (see inferSeniority) on top of this test's two full
    // analyze() calls — consistently ~5.5s, right past the 5000ms default.
    10000
  );

  it("is available from a FAILED run, per the plan's own-word framing (обработанных или упавших)", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    runRepo.updateRun(run.id, { state: WorkflowState.FAILED, failedFromState: WorkflowState.ANALYZING });

    const result = await orchestrator.retryAnalysis(run.id);
    expect(result.run.state).toBe(WorkflowState.ANALYSIS_READY);
  });

  it("refuses to run while the run is in a transient in-progress state", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    runRepo.updateRun(run.id, { state: WorkflowState.ANALYZING });

    await expect(orchestrator.retryAnalysis(run.id)).rejects.toThrow();
    await expect(orchestrator.deleteRun(run.id)).rejects.toThrow();
  });

  it("refuses to run while a regeneratePiece/addQuestion call is still in flight for the same run (no state transition to catch it otherwise)", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Senior Engineer at Acme" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);
    await orchestrator.generate(run.id, { manualQuestions: [{ id: "q1", question: "Why this role?" }] });

    let resolveExamples!: (value: { examples: string[] }) => void;
    const pending = new Promise<{ examples: string[] }>((resolve) => {
      resolveExamples = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (orchestrator as any).coverLetterLibrary.execute = () => pending;

    const regenerateCall = orchestrator.regeneratePiece(run.id, "q1");

    // The run's own workflow state never changes during regeneratePiece —
    // this is exactly the case TRANSIENT_STATES can't catch, and the whole
    // point of this fix.
    expect(orchestrator.getRun(run.id).state).toBe(WorkflowState.PACKAGE_READY);
    await expect(orchestrator.retryAnalysis(run.id)).rejects.toThrow(/already running/i);
    await expect(orchestrator.deleteRun(run.id)).rejects.toThrow(/already running/i);

    resolveExamples({ examples: [] });
    await regenerateCall;
  });

  it("permanently removes the run's DB rows and on-disk directory", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    expect(fs.existsSync(runDir(run.id))).toBe(true);
    expect(orchestrator.getTrace(run.id).length).toBeGreaterThan(0);

    await orchestrator.deleteRun(run.id);

    expect(() => orchestrator.getRun(run.id)).toThrow();
    expect(fs.existsSync(runDir(run.id))).toBe(false);
  });
});
