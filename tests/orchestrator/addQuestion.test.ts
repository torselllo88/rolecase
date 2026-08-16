import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { RunRepository } from "../../src/persistence/runRepository.js";
import { fileStore } from "../../src/persistence/fileStore.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { WorkflowState } from "../../src/types/workflow.js";

describe("Orchestrator.addQuestion", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;
  let runRepo: RunRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
    runRepo = new RunRepository(db);
  });

  async function runToPackageReady(manualQuestions: { id: string; question: string }[] = []) {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Senior Engineer at Acme" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);
    await orchestrator.generate(run.id, { manualQuestions });
    return run;
  }

  it("refuses to run while the run is in a transient in-progress state", async () => {
    const run = await runToPackageReady();
    runRepo.updateRun(run.id, { state: WorkflowState.GENERATING_PACKAGE });

    await expect(orchestrator.addQuestion(run.id, { question: "Why this role?" })).rejects.toThrow();
  });

  it("refuses when no application package exists yet", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    await expect(orchestrator.addQuestion(run.id, { question: "Why this role?" })).rejects.toThrow(
      /no application package/i
    );
  });

  it("refuses with a clear message for a run whose package predates resume-selection.json", async () => {
    const run = await runToPackageReady();
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { env } = await import("../../src/config/env.js");
    fs.rmSync(path.join(env.dataDir, "runs", run.id, "application-package", "resume-selection.json"));

    await expect(orchestrator.addQuestion(run.id, { question: "Why this role?" })).rejects.toThrow(/predates/i);
  });

  it("refuses with a clear message for a run whose evidence-mapping.json predates the multi-piece shape", async () => {
    const run = await runToPackageReady();
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { env } = await import("../../src/config/env.js");
    fs.writeFileSync(
      path.join(env.dataDir, "runs", run.id, "application-package", "evidence-mapping.json"),
      JSON.stringify({ entries: [], unsupportedClaims: [] })
    );

    await expect(orchestrator.addQuestion(run.id, { question: "Why this role?" })).rejects.toThrow(/legacy/i);
  });

  it("skips the length-limit warning for a piece that never converged, same as generate()'s own check", async () => {
    const run = await runToPackageReady();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (orchestrator as any).agents.critic.execute = async (input: any) => ({
      pieceReviews: input.pieces.map((p: { id: string }) => ({
        pieceId: p.id,
        issues: [{ severity: "major", description: "fixture: never converges" }],
        qualityScore: 10,
      })),
    });

    const result = await orchestrator.addQuestion(run.id, {
      question: "Why this role?",
      maxCharacters: 1, // the stub answer is always far longer than 1 character
    });

    expect(result.warnings.some((w) => /above the configured maximum/i.test(w))).toBe(false);
  });

  it("appends the new question without disturbing existing pieces' evidence/review entries", async () => {
    const run = await runToPackageReady([{ id: "q1", question: "Why this role?" }]);
    const before = orchestrator.getApplicationPackageFiles(run.id);
    const evidenceBefore = JSON.parse(before["evidence-mapping.json"]!);
    const reviewBefore = JSON.parse(before["final-review.json"]!);
    const answersBefore = JSON.parse(before["application-answers.json"]!);

    const result = await orchestrator.addQuestion(run.id, {
      question: "Describe a challenge you overcame.",
      maxCharacters: 300,
      guidance: "Mention my open-source work",
    });

    expect(result.run.state).toBe(WorkflowState.PACKAGE_READY); // untouched — no state transition
    const after = orchestrator.getApplicationPackageFiles(run.id);
    const answersAfter = JSON.parse(after["application-answers.json"]!);
    expect(answersAfter).toHaveLength(answersBefore.length + 1);
    expect(answersAfter.slice(0, answersBefore.length)).toEqual(answersBefore);
    const newAnswer = answersAfter[answersAfter.length - 1];
    expect(newAnswer.question).toBe("Describe a challenge you overcame.");
    expect(newAnswer.maxCharacters).toBe(300);

    const evidenceAfter = JSON.parse(after["evidence-mapping.json"]!);
    expect(evidenceAfter.pieceResults).toHaveLength(evidenceBefore.pieceResults.length + 1);
    // Existing pieces' evidence entries are byte-identical to before.
    for (const entry of evidenceBefore.pieceResults) {
      expect(evidenceAfter.pieceResults.find((r: { pieceId: string }) => r.pieceId === entry.pieceId)).toEqual(entry);
    }

    const reviewAfter = JSON.parse(after["final-review.json"]!);
    expect(reviewAfter.pieceReviews).toHaveLength(reviewBefore.pieceReviews.length + 1);
    for (const entry of reviewBefore.pieceReviews) {
      expect(reviewAfter.pieceReviews.find((r: { pieceId: string }) => r.pieceId === entry.pieceId)).toEqual(entry);
    }

    // A later full regenerate would keep answering it too.
    const settings = fileStore.readGenerationSettings(run.id);
    expect(settings?.manualQuestions).toHaveLength(2);
    const persisted = settings?.manualQuestions.find((q) => q.question === "Describe a challenge you overcame.");
    expect(persisted?.guidance).toBe("Mention my open-source work");
    expect(persisted?.maxCharacters).toBe(300);
  });

  it("still persists the new question even if generation-settings.json is unexpectedly missing", async () => {
    const run = await runToPackageReady();
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { env } = await import("../../src/config/env.js");
    fs.rmSync(path.join(env.dataDir, "runs", run.id, "generation-settings.json"));

    await orchestrator.addQuestion(run.id, { question: "Why this role?" });

    const settings = fileStore.readGenerationSettings(run.id);
    expect(settings?.manualQuestions).toHaveLength(1);
    expect(settings?.manualQuestions[0]?.question).toBe("Why this role?");
  });

  it("warns when the new answer exceeds its detected character limit", async () => {
    const run = await runToPackageReady();

    const result = await orchestrator.addQuestion(run.id, {
      question: "Why this role?",
      maxCharacters: 1, // the stub answer is always far longer than 1 character
    });

    expect(result.warnings.some((w) => /above the configured maximum/i.test(w))).toBe(true);
  });

  it("rejects a concurrent addQuestion/generate call for the same run while one is still in flight", async () => {
    const run = await runToPackageReady();

    let resolveExamples!: (value: { examples: string[] }) => void;
    const pending = new Promise<{ examples: string[] }>((resolve) => {
      resolveExamples = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (orchestrator as any).coverLetterLibrary.execute = () => pending;

    const firstCall = orchestrator.addQuestion(run.id, { question: "Why this role?" });
    await expect(orchestrator.addQuestion(run.id, { question: "Another one?" })).rejects.toThrow(/already running/i);
    await expect(orchestrator.generate(run.id)).rejects.toThrow(/already running/i);

    resolveExamples({ examples: [] });
    await firstCall;
  });
});
