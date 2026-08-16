import { describe, expect, it } from "vitest";
import { VacancyAnalyzerAgent } from "../../src/agents/vacancyAnalyzerAgent.js";
import { buildAgentRequest } from "../../src/agents/baseAgent.js";
import { AgentName } from "../../src/types/agent.js";
import { Tracer } from "../../src/observability/tracer.js";
import { FakeLlmProvider } from "../helpers/fakeLlmProvider.js";

const NORMALIZED_VACANCY = {
  company: "Acme",
  title: "Senior Engineer",
  location: "Remote",
  employmentType: "full_time" as const,
  requirements: ["Python"],
  responsibilities: ["Ship things"],
  benefits: ["Health insurance"],
  applicationQuestions: [],
  keywords: ["python", "backend"],
};

describe("VacancyAnalyzerAgent", () => {
  it("falls back to the deterministic stub when no LLM is configured", async () => {
    const agent = new VacancyAnalyzerAgent();
    const tracer = new Tracer("run-1");
    const request = buildAgentRequest(
      "run-1",
      AgentName.VACANCY_ANALYZER,
      { rawText: "Senior Engineer at Acme" }
    );

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    // Extracted from the raw text's own "<Title> at <Company>" pattern, not a fabricated placeholder.
    expect(response.output.vacancy.company).toBe("Acme");
    expect(response.output.vacancy.title).toBe("Senior Engineer");
    expect(tracer.flush().some((e) => e.eventType === "model_call")).toBe(false);
  });

  it("parses via the LLM but keeps fit-analysis stubbed when no candidate profile is given", async () => {
    const agent = new VacancyAnalyzerAgent();
    const tracer = new Tracer("run-2");
    const llm = new FakeLlmProvider({
      VacancyParse: [{ vacancy: NORMALIZED_VACANCY, summary: "A role at Acme." }],
    });
    const request = buildAgentRequest(
      "run-2",
      AgentName.VACANCY_ANALYZER,
      { rawText: "Senior Engineer at Acme" }
    );

    const response = await agent.run(request, { tracer, tools: { llm } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.vacancy).toEqual(NORMALIZED_VACANCY);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.schemaName).toBe("VacancyParse");
    expect(tracer.flush().some((e) => e.eventType === "model_call" && e.agentName === "VACANCY_ANALYZER")).toBe(
      true
    );
  });

  it("parses and assesses fit in one grounded call when a candidate profile is given", async () => {
    const agent = new VacancyAnalyzerAgent();
    const tracer = new Tracer("run-3");
    const groundedOutput = {
      vacancy: NORMALIZED_VACANCY,
      summary: "A role at Acme.",
      fitAnalysis: {
        fitScore: 82,
        strengths: ["5 years of Python at ExampleCorp"],
        weaknesses: [],
        missingSkills: [],
        atsKeywordCoverage: [{ keyword: "python", covered: true }],
        strategicRecommendation: "Strong match.",
        suggestedResumeHint: "main-resume",
      },
    };
    const llm = new FakeLlmProvider({ VacancyAnalysisWithFit: [groundedOutput] });
    const request = buildAgentRequest("run-3", AgentName.VACANCY_ANALYZER, {
      rawText: "Senior Engineer at Acme",
      candidateProfileText: "=== Resume: main-resume ===\n5 years of Python at ExampleCorp",
    });

    const response = await agent.run(request, { tracer, tools: { llm } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.fitAnalysis.fitScore).toBe(82);
    expect(response.output.fitAnalysis.suggestedResumeHint).toBe("main-resume");
    expect(llm.calls[0]?.schemaName).toBe("VacancyAnalysisWithFit");
    expect(llm.calls[0]?.userPrompt).toContain("main-resume");
  });
});
