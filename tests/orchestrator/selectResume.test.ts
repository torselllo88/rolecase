import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithWorkspace, type WorkspaceContext } from "../../src/config/workspaceContext.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { fileStore } from "../../src/persistence/fileStore.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { createResumeTextEntry, deleteResumeFile } from "../../src/tools/resumeLibrary.js";
import { WorkflowState } from "../../src/types/workflow.js";

describe("Orchestrator.selectResume", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;
  // Own data dir per test — these tests add resumes to the library, which
  // must never leak into any other test file sharing .vitest-data.
  let ctx: WorkspaceContext;
  let firstId: string;
  let secondId: string;

  const inWorkspace = <T>(fn: () => T): T => runWithWorkspace(ctx, fn);

  beforeEach(() => {
    ctx = { key: "admin", kind: "admin", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "select-resume-")) };
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
    inWorkspace(() => {
      firstId = createResumeTextEntry("a-backend", "Backend engineer. TypeScript, Node.js, PostgreSQL.");
      secondId = createResumeTextEntry("b-frontend", "Frontend engineer. React, CSS, accessibility.");
    });
  });

  afterEach(() => {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  async function analyzedRun() {
    const run = inWorkspace(() => orchestrator.createRun({ sourceType: "raw_text", source: "Senior Engineer at Acme" }));
    await inWorkspace(() => orchestrator.analyze(run.id));
    return run;
  }

  it("lets the agent pick a resume right after analysis, without changing the workflow state", async () => {
    const run = await analyzedRun();

    const result = await inWorkspace(() => orchestrator.selectResume(run.id));

    expect(result.run.state).toBe(WorkflowState.ANALYSIS_READY);
    const stored = inWorkspace(() => orchestrator.getResumeSelection(run.id));
    expect(stored?.source).toBe("agent");
    expect([firstId, secondId]).toContain(stored?.selectedResumeId);
    // Nothing else got generated.
    expect(inWorkspace(() => orchestrator.getApplicationPackageFiles(run.id))).toEqual({});
  });

  it("generate() reuses a hand-picked resume instead of re-running the selector", async () => {
    const run = await analyzedRun();
    // The stub selector would pick the first resume — pick the other one by hand.
    await inWorkspace(() => orchestrator.selectResume(run.id, secondId));
    expect(inWorkspace(() => orchestrator.getResumeSelection(run.id))?.source).toBe("manual");

    await inWorkspace(() => orchestrator.approve(run.id));
    const result = await inWorkspace(() => orchestrator.generate(run.id, { manualQuestions: [] }));

    expect(result.run.state).toBe(WorkflowState.PACKAGE_READY);
    const files = inWorkspace(() => orchestrator.getApplicationPackageFiles(run.id));
    expect(JSON.parse(files["resume-selection.json"]!).selectedResumeId).toBe(secondId);
  });

  it("generate() stores its own selection when none was made beforehand", async () => {
    const run = await analyzedRun();
    await inWorkspace(() => orchestrator.approve(run.id));
    await inWorkspace(() => orchestrator.generate(run.id, { manualQuestions: [] }));

    expect(inWorkspace(() => orchestrator.getResumeSelection(run.id))?.source).toBe("agent");
  });

  it("re-selects with a warning when the stored resume was removed from the library", async () => {
    const run = await analyzedRun();
    await inWorkspace(() => orchestrator.selectResume(run.id, secondId));
    inWorkspace(() => deleteResumeFile(secondId));

    await inWorkspace(() => orchestrator.approve(run.id));
    const result = await inWorkspace(() => orchestrator.generate(run.id, { manualQuestions: [] }));

    expect(result.warnings.some((w) => /no longer in the Resume Library/.test(w))).toBe(true);
    const files = inWorkspace(() => orchestrator.getApplicationPackageFiles(run.id));
    expect(JSON.parse(files["resume-selection.json"]!).selectedResumeId).toBe(firstId);
  });

  it("rejects an unknown resume id and persists nothing", async () => {
    const run = await analyzedRun();

    await expect(inWorkspace(() => orchestrator.selectResume(run.id, "no-such-resume"))).rejects.toThrow(
      /no resume "no-such-resume"/i
    );
    expect(inWorkspace(() => orchestrator.getResumeSelection(run.id))).toBeUndefined();
  });

  it("refuses before analysis and once a package is ready", async () => {
    const fresh = inWorkspace(() => orchestrator.createRun({ sourceType: "raw_text", source: "Some role" }));
    await expect(inWorkspace(() => orchestrator.selectResume(fresh.id))).rejects.toThrow(/select_resume/);

    const run = await analyzedRun();
    await inWorkspace(() => orchestrator.approve(run.id));
    await inWorkspace(() => orchestrator.generate(run.id, { manualQuestions: [] }));
    await expect(inWorkspace(() => orchestrator.selectResume(run.id, firstId))).rejects.toThrow(/select_resume/);
  });

  it("is cleared by retryAnalysis, along with the rest of the downstream artifacts", async () => {
    const run = await analyzedRun();
    await inWorkspace(() => orchestrator.selectResume(run.id, secondId));

    await inWorkspace(() => orchestrator.retryAnalysis(run.id));

    expect(inWorkspace(() => fileStore.readResumeSelection(run.id))).toBeUndefined();
  });
});
