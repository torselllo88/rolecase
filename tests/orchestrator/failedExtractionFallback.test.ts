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

describe("Orchestrator.analyze — failed-extraction fallback", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
    extractContentMock.mockReset();
  });

  it("fails fast with an actionable message instead of forwarding a bot-check page to the LLM", async () => {
    extractContentMock.mockResolvedValueOnce({ rawText: "Just a quick security check" });
    const run = orchestrator.createRun({ sourceType: "url", source: "https://example.com/jobs/1" });

    const result = await orchestrator.analyze(run.id);

    expect(result.run.state).toBe(WorkflowState.FAILED);
    expect(result.run.errorMessage).toMatch(/could not be scraped/i);
    expect(result.run.errorMessage).toMatch(/edit the vacancy source/i);
    expect(orchestrator.getVacancyReport(run.id)).toBeUndefined();
  });

  it("proceeds normally when the extracted content looks like a real posting", async () => {
    extractContentMock.mockResolvedValueOnce({
      rawText:
        "Senior Backend Engineer at Acme Corp. We are looking for an experienced backend " +
        "engineer to own our payments platform. Requirements: 5+ years of distributed systems " +
        "experience, strong Node.js or Go skills. We offer competitive pay and remote work.",
    });
    const run = orchestrator.createRun({ sourceType: "url", source: "https://example.com/jobs/2" });

    const result = await orchestrator.analyze(run.id);

    expect(result.run.state).toBe(WorkflowState.ANALYSIS_READY);
  });

  it("never applies the heuristic to a raw_text-sourced run — pasted text is trusted even if short", async () => {
    const run = orchestrator.createRun({ sourceType: "raw_text", source: "Short role" });

    const result = await orchestrator.analyze(run.id);

    expect(result.run.state).toBe(WorkflowState.ANALYSIS_READY);
    expect(extractContentMock).not.toHaveBeenCalled();
  });
});
