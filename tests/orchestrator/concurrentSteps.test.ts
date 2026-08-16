import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { WorkflowState } from "../../src/types/workflow.js";

const { extractContentMock } = vi.hoisted(() => ({
  extractContentMock: vi.fn(),
}));

vi.mock("../../src/tools/vacancyScraper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/vacancyScraper.js")>();
  return {
    ...actual,
    extractContentTool: { ...actual.extractContentTool, execute: extractContentMock },
  };
});

describe("Orchestrator — concurrent duplicate step execution", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
    extractContentMock.mockReset();
  });

  it("rejects a second concurrent analyze() call for the same run while the first is still in flight", async () => {
    const run = orchestrator.createRun({ sourceType: "url", source: "https://example.com/job" });

    let resolveExtract!: (value: { rawText: string }) => void;
    extractContentMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExtract = resolve;
      })
    );

    const firstCall = orchestrator.analyze(run.id);
    await expect(orchestrator.analyze(run.id)).rejects.toThrow(/already running/i);

    resolveExtract({ rawText: "Senior Engineer at Acme\nA genuine, substantive job posting." });
    const result = await firstCall;
    expect(result.run.state).toBe(WorkflowState.ANALYSIS_READY);
  });

  it("releases the guard after the step finishes, so a later sequential call succeeds normally", async () => {
    extractContentMock.mockResolvedValue({ rawText: "Senior Engineer at Acme\nA genuine, substantive job posting." });
    const run = orchestrator.createRun({ sourceType: "url", source: "https://example.com/job" });

    await orchestrator.analyze(run.id);
    await orchestrator.approve(run.id);

    // approve() is a different command for the same run, run only after
    // analyze() has fully released the guard — must not be blocked by it.
    expect(orchestrator.getRun(run.id).state).toBe(WorkflowState.ANALYSIS_APPROVED);
  });
});
