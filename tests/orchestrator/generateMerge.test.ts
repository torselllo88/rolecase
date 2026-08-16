import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { fileStore } from "../../src/persistence/fileStore.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";

describe("Orchestrator.generate — manual questions", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
  });

  it("answers a manual question and persists generation-settings.json", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    const result = await orchestrator.generate(run.id, {
      manualQuestions: [{ id: "manual-1", question: "Describe a challenge you overcame.", maxCharacters: 400 }],
    });
    expect(result.run.state).toBe("PACKAGE_READY");

    const files = orchestrator.getApplicationPackageFiles(run.id);
    const answers = JSON.parse(files["application-answers.json"]!);
    const answerIds = answers.map((a: { id: string }) => a.id).sort();

    expect(answerIds).toEqual(["manual-1"]);

    const settings = fileStore.readGenerationSettings(run.id);
    expect(settings?.manualQuestions).toEqual([
      { id: "manual-1", question: "Describe a challenge you overcame.", maxCharacters: 400 },
    ]);
  });

  it("falls back to previously persisted manual questions on a regenerate that doesn't pass any", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    await orchestrator.generate(run.id, { manualQuestions: [{ id: "manual-1", question: "Why this role?" }] });
    await orchestrator.rejectPackage(run.id);

    // Regenerate without passing manualQuestions at all.
    const result = await orchestrator.generate(run.id);
    expect(result.run.state).toBe("PACKAGE_READY");

    const files = orchestrator.getApplicationPackageFiles(run.id);
    const answers = JSON.parse(files["application-answers.json"]!);
    expect(answers.map((a: { id: string }) => a.id)).toEqual(["manual-1"]);
  });

  it("falls back to previously persisted limits on a regenerate that doesn't pass any", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    await orchestrator.generate(run.id, {
      limits: { coverLetterMinWords: 10, coverLetterMaxWords: 20, answerMaxWords: 30 },
    });
    await orchestrator.rejectPackage(run.id);

    // Regenerate without passing limits at all — must reuse what was persisted,
    // not silently reset to the env defaults (450/150/etc).
    await orchestrator.generate(run.id);

    const settings = fileStore.readGenerationSettings(run.id);
    expect(settings?.limits).toEqual({ coverLetterMinWords: 10, coverLetterMaxWords: 20, answerMaxWords: 30 });
  });

  it("applies the admin's app-wide default limits when the caller's override object has all-blank fields (the GUI's actual shape)", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    orchestrator.updateSettings({ defaultLimits: { answerMaxWords: 777 } });

    // Mirrors exactly what gui/server.ts's parseWriterLimitsOverride() builds
    // for a GUI submit with every limit field left blank: a defined object,
    // each field individually undefined — not an undefined `limits` key.
    await orchestrator.generate(run.id, {
      limits: { coverLetterMinWords: undefined, coverLetterMaxWords: undefined, answerMaxWords: undefined },
    });

    const settings = fileStore.readGenerationSettings(run.id);
    expect(settings?.limits?.answerMaxWords).toBe(777);
  });

  it("warns when generating with an empty Resume Library instead of shipping a silent resume-less package", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    const result = await orchestrator.generate(run.id);

    expect(result.warnings.some((w) => /no resume is on file/i.test(w))).toBe(true);
  });

  it("produces zero application answers when no manual questions were provided", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role" });
    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    await orchestrator.generate(run.id);

    const files = orchestrator.getApplicationPackageFiles(run.id);
    const answers = JSON.parse(files["application-answers.json"]!);
    expect(answers).toEqual([]);
  });
});
