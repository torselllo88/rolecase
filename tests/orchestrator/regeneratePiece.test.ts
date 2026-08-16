import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { RunRepository } from "../../src/persistence/runRepository.js";
import { fileStore } from "../../src/persistence/fileStore.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { WorkflowState } from "../../src/types/workflow.js";

describe("Orchestrator.regeneratePiece", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;
  let runRepo: RunRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
    runRepo = new RunRepository(db);
  });

  async function runToPackageReady(
    manualQuestions: { id: string; question: string; guidance?: string; maxCharacters?: number }[]
  ) {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Senior Engineer at Acme" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);
    await orchestrator.generate(run.id, { manualQuestions });
    return run;
  }

  it("refuses to run while the run is in a transient in-progress state", async () => {
    const run = await runToPackageReady([{ id: "q1", question: "Why this role?" }]);
    runRepo.updateRun(run.id, { state: WorkflowState.GENERATING_PACKAGE });

    await expect(orchestrator.regeneratePiece(run.id, "q1")).rejects.toThrow();
  });

  it("refuses when no application package exists yet", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    await expect(orchestrator.regeneratePiece(run.id, "cover_letter")).rejects.toThrow(/no application package/i);
  });

  it("refuses to regenerate the cover letter when it was toggled off", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);
    await orchestrator.generate(run.id, { manualQuestions: [{ id: "q1", question: "Why?" }], includeCoverLetter: false });

    await expect(orchestrator.regeneratePiece(run.id, "cover_letter")).rejects.toThrow(/no cover letter/i);
  });

  it("refuses with a clear message for a run whose package predates resume-selection.json", async () => {
    const run = await runToPackageReady([]);
    // Simulate a run generated before this fix — delete the structured file,
    // leaving only the legacy resume-edits.md.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { env } = await import("../../src/config/env.js");
    fs.rmSync(path.join(env.dataDir, "runs", run.id, "application-package", "resume-selection.json"));

    await expect(orchestrator.regeneratePiece(run.id, "cover_letter")).rejects.toThrow(/predates/i);
  });

  it("refuses for an unknown piece id", async () => {
    const run = await runToPackageReady([{ id: "q1", question: "Why this role?" }]);
    await expect(orchestrator.regeneratePiece(run.id, "not-a-real-id")).rejects.toThrow(/no such piece/i);
  });

  it("refuses with a clear message for a run whose evidence-mapping.json predates the multi-piece shape", async () => {
    const run = await runToPackageReady([{ id: "q1", question: "Why this role?" }]);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { env } = await import("../../src/config/env.js");
    // Legacy pre-ebba8e0 shape: no `pieceResults` array. Valid JSON, so the
    // JSON.parse try/catch elsewhere wouldn't have caught this on its own.
    fs.writeFileSync(
      path.join(env.dataDir, "runs", run.id, "application-package", "evidence-mapping.json"),
      JSON.stringify({ entries: [], unsupportedClaims: [] })
    );

    await expect(orchestrator.regeneratePiece(run.id, "q1")).rejects.toThrow(/legacy/i);
  });

  it("refuses with a clear message for a run whose final-review.json predates the multi-piece shape", async () => {
    const run = await runToPackageReady([{ id: "q1", question: "Why this role?" }]);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { env } = await import("../../src/config/env.js");
    // Legacy pre-ebba8e0 shape: no `pieceReviews` array.
    fs.writeFileSync(
      path.join(env.dataDir, "runs", run.id, "application-package", "final-review.json"),
      JSON.stringify({ issues: [], qualityScore: 80 })
    );

    await expect(orchestrator.regeneratePiece(run.id, "q1")).rejects.toThrow(/legacy/i);
  });

  it("regenerates a manual question without dropping its originally-set guidance when no new note is given", async () => {
    const run = await runToPackageReady([
      { id: "q1", question: "Why this role?", guidance: "Mention my open-source work" },
    ]);

    let capturedGuidance: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writerAgent = (orchestrator as any).agents.writer;
    const originalRun = writerAgent.run.bind(writerAgent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (orchestrator as any).agents.writer.run = async (request: any, ctx: any) => {
      capturedGuidance = request.input.applicationQuestions?.[0]?.guidance;
      return originalRun(request, ctx);
    };

    await orchestrator.regeneratePiece(run.id, "q1");

    expect(capturedGuidance).toBe("Mention my open-source work");
  });

  it("regenerates only the targeted answer, leaving other pieces' evidence/review entries untouched", async () => {
    const run = await runToPackageReady([
      { id: "q1", question: "Why this role?" },
      { id: "q2", question: "Describe a challenge." },
    ]);
    const before = orchestrator.getApplicationPackageFiles(run.id);
    const evidenceBefore = JSON.parse(before["evidence-mapping.json"]!);
    const reviewBefore = JSON.parse(before["final-review.json"]!);
    expect(evidenceBefore.pieceResults.map((r: { pieceId: string }) => r.pieceId).sort()).toEqual([
      "cover_letter",
      "q1",
      "q2",
    ]);

    const result = await orchestrator.regeneratePiece(run.id, "q1", "Mention my open-source work");

    expect(result.run.state).toBe(WorkflowState.PACKAGE_READY); // untouched — no state transition
    const after = orchestrator.getApplicationPackageFiles(run.id);
    const answersAfter = JSON.parse(after["application-answers.json"]!);
    expect(answersAfter.map((a: { id: string }) => a.id).sort()).toEqual(["q1", "q2"]);

    const evidenceAfter = JSON.parse(after["evidence-mapping.json"]!);
    expect(evidenceAfter.pieceResults.map((r: { pieceId: string }) => r.pieceId).sort()).toEqual([
      "cover_letter",
      "q1",
      "q2",
    ]);
    // Untouched pieces' evidence entries are byte-identical to before.
    const q2Before = evidenceBefore.pieceResults.find((r: { pieceId: string }) => r.pieceId === "q2");
    const q2After = evidenceAfter.pieceResults.find((r: { pieceId: string }) => r.pieceId === "q2");
    expect(q2After).toEqual(q2Before);

    const reviewAfter = JSON.parse(after["final-review.json"]!);
    expect(reviewAfter.pieceReviews.map((r: { pieceId: string }) => r.pieceId).sort()).toEqual([
      "cover_letter",
      "q1",
      "q2",
    ]);
    const q2ReviewBefore = reviewBefore.pieceReviews.find((r: { pieceId: string }) => r.pieceId === "q2");
    const q2ReviewAfter = reviewAfter.pieceReviews.find((r: { pieceId: string }) => r.pieceId === "q2");
    expect(q2ReviewAfter).toEqual(q2ReviewBefore);

    // The guidance note is persisted for a future full regenerate too.
    const settings = fileStore.readGenerationSettings(run.id);
    expect(settings?.guidanceById?.q1).toBe("Mention my open-source work");
  });

  it("warns when the regenerated answer exceeds its configured character limit — retrofit for a real gap (regeneratePiece previously ran no length check at all)", async () => {
    // The manual question's own maxCharacters carries the limit (no detected
    // fields anymore — see the OSS removal of Playwright-based form detection).
    const run = await runToPackageReady([{ id: "q1", question: "Why this role?", maxCharacters: 1 }]);

    const result = await orchestrator.regeneratePiece(run.id, "q1");

    expect(result.warnings.some((w) => /above the configured maximum of 1 characters/i.test(w))).toBe(true);
  });

  it("skips the length-limit warning for a piece that never converged, same as generate()'s own check", async () => {
    const run = await runToPackageReady([{ id: "q1", question: "Why this role?", maxCharacters: 1 }]);

    // Force Critic to never approve, regardless of iteration — the piece is
    // force-locked as converged:false on the last iteration, same as a real
    // persistently-failing LLM response would produce.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (orchestrator as any).agents.critic.execute = async (input: any) => ({
      pieceReviews: input.pieces.map((p: { id: string }) => ({
        pieceId: p.id,
        issues: [{ severity: "major", description: "fixture: never converges" }],
        qualityScore: 10,
      })),
    });

    const result = await orchestrator.regeneratePiece(run.id, "q1");

    expect(result.warnings.some((w) => /above the configured maximum/i.test(w))).toBe(false);
  });

  it("rejects a concurrent regeneratePiece/generate call for the same run while one is still in flight", async () => {
    const run = await runToPackageReady([{ id: "q1", question: "Why this role?" }]);

    let resolveExamples!: (value: { examples: string[] }) => void;
    const pending = new Promise<{ examples: string[] }>((resolve) => {
      resolveExamples = resolve;
    });
    // Monkey-patch this one orchestrator instance's cover-letter-library call
    // to hang, creating a controllable in-flight window — same technique the
    // detectingFields concurrency tests use, applied to a different tool.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (orchestrator as any).coverLetterLibrary.execute = () => pending;

    const firstCall = orchestrator.regeneratePiece(run.id, "q1");
    await expect(orchestrator.regeneratePiece(run.id, "q1")).rejects.toThrow(/already running/i);
    await expect(orchestrator.generate(run.id)).rejects.toThrow(/already running/i);

    resolveExamples({ examples: [] });
    await firstCall;
  });
});
