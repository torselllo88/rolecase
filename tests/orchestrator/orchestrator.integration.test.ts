import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { WorkflowState } from "../../src/types/workflow.js";

describe("Orchestrator integration", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
  });

  it("drives the full happy path end-to-end", async () => {
    const run = orchestrator.createRun({
      sourceType: "raw_text",
      source: "Senior Engineer at Acme\nGreat role with strong growth potential.",
    });
    expect(run.state).toBe(WorkflowState.CREATED);

    const analyzed = await orchestrator.analyze(run.id);
    expect(analyzed.run.state).toBe(WorkflowState.ANALYSIS_READY);
    expect(analyzed.run.recommendation).toBeTruthy();

    const approved = await orchestrator.approve(run.id);
    expect(approved.run.state).toBe(WorkflowState.ANALYSIS_APPROVED);

    const generated = await orchestrator.generate(run.id);
    expect(generated.run.state).toBe(WorkflowState.PACKAGE_READY);

    const accepted = await orchestrator.accept(run.id);
    expect(accepted.run.state).toBe(WorkflowState.PACKAGE_ACCEPTED);

    const done = await orchestrator.confirmSubmit(run.id);
    expect(done.run.state).toBe(WorkflowState.DONE);

    const trace = orchestrator.getTrace(run.id);
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.some((event) => event.eventType === "state_transition")).toBe(true);
  });

  it("terminates cleanly on reject at gate 1, with no package artifacts", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);

    const rejected = await orchestrator.reject(run.id);
    expect(rejected.run.state).toBe(WorkflowState.REJECTED);
    expect(orchestrator.getApplicationPackageFiles(run.id)).toEqual({});
  });

  it("refuses an out-of-order command without changing state", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });

    await expect(orchestrator.approve(run.id)).rejects.toThrow();
    expect(orchestrator.getRun(run.id).state).toBe(WorkflowState.CREATED);
  });

  it("warns instead of silently discarding hand-edited package files on regenerate", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);
    await orchestrator.generate(run.id);
    await orchestrator.rejectPackage(run.id);

    const fs = await import("node:fs");
    const path = await import("node:path");
    const { env } = await import("../../src/config/env.js");
    const coverLetterPath = path.join(
      env.dataDir,
      "runs",
      run.id,
      "application-package",
      "cover-letter.md"
    );
    fs.writeFileSync(coverLetterPath, "Hand-edited content that should not vanish silently.");

    const regenerated = await orchestrator.generate(run.id);
    expect(regenerated.run.state).toBe(WorkflowState.PACKAGE_READY);
    expect(regenerated.warnings.some((w) => w.includes("cover-letter.md"))).toBe(true);
  });
});
