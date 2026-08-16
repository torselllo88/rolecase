import { describe, expect, it, vi } from "vitest";
import {
  CompanyResearchAgent,
  inferSeniority,
  looksLikeSalaryData,
} from "../../src/agents/companyResearchAgent.js";
import { buildAgentRequest } from "../../src/agents/baseAgent.js";
import { AgentName } from "../../src/types/agent.js";
import { Tracer } from "../../src/observability/tracer.js";
import { SearchBroker } from "../../src/tools/searchBroker.js";
import { FakeLlmProvider } from "../helpers/fakeLlmProvider.js";

describe("inferSeniority", () => {
  it("extracts a common seniority marker from the title", () => {
    expect(inferSeniority("Senior Backend Engineer")).toMatch(/senior/i);
    expect(inferSeniority("Staff Product Manager")).toMatch(/staff/i);
  });

  it("returns undefined when no marker is present", () => {
    expect(inferSeniority("Backend Engineer")).toBeUndefined();
  });
});

describe("looksLikeSalaryData", () => {
  it("recognizes a currency-bearing snippet", () => {
    expect(looksLikeSalaryData([{ url: "u", title: "t", snippet: "Salary range: $120,000-$150,000/year" }])).toBe(
      true
    );
  });

  it("rejects a generic, comp-free snippet", () => {
    expect(looksLikeSalaryData([{ url: "u", title: "Great place to work", snippet: "People love the culture here." }])).toBe(
      false
    );
  });
});

describe("CompanyResearchAgent", () => {
  it("returns stub signals when no LLM is configured, sourced from real search results", async () => {
    const agent = new CompanyResearchAgent();
    const tracer = new Tracer("run-1");
    // No BRAVE_SEARCH_API_KEY in the test environment (see vitest.config.ts),
    // so this SearchBroker instance already runs its own deterministic stub —
    // exactly what production code does when Brave isn't configured either.
    const searchBroker = new SearchBroker();
    const request = buildAgentRequest("run-1", AgentName.COMPANY_RESEARCH, {
      companyName: "Acme",
      vacancyTitle: "Senior Backend Engineer",
    });

    const response = await agent.run(request, { tracer, tools: { searchBroker } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.sources.length).toBeGreaterThan(0);
    expect(response.output.salaryInsight.source).toBe("unavailable");
    expect(tracer.flush().some((e) => e.eventType === "model_call")).toBe(false);
  });

  it("synthesizes signals and a salary insight from real search snippets when an LLM is configured", async () => {
    const agent = new CompanyResearchAgent();
    const tracer = new Tracer("run-2");
    const searchBroker = new SearchBroker();
    const llm = new FakeLlmProvider({
      CompanySignalsAndSalary: [
        {
          positiveSignals: ["High Glassdoor rating"],
          risks: ["Reports of long hours"],
          salaryRange: "$120,000-$150,000/year",
          salarySource: "role_at_company",
          salarySourceNote: "Based on real listings for this exact role at this company.",
        },
      ],
    });
    const request = buildAgentRequest("run-2", AgentName.COMPANY_RESEARCH, {
      companyName: "Acme",
      vacancyTitle: "Senior Backend Engineer",
    });

    const response = await agent.run(request, { tracer, tools: { searchBroker, llm } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.positiveSignals).toEqual(["High Glassdoor rating"]);
    expect(response.output.risks).toEqual(["Reports of long hours"]);
    expect(response.output.sources.length).toBeGreaterThan(0);
    expect(response.output.salaryInsight.range).toBe("$120,000-$150,000/year");
    expect(llm.calls[0]?.schemaName).toBe("CompanySignalsAndSalary");
    expect(tracer.flush().some((e) => e.eventType === "model_call" && e.agentName === "COMPANY_RESEARCH")).toBe(
      true
    );
  });

  it("escalates the salary ladder past a non-substantive tier and tags the resulting source", async () => {
    const agent = new CompanyResearchAgent();
    const tracer = new Tracer("run-3");
    const executeMock = vi
      .fn()
      // culture-research query
      .mockResolvedValueOnce({ results: [], cacheHit: false })
      // tier 1: role_at_company — no salary data
      .mockResolvedValueOnce({
        results: [{ url: "https://example.com/1", title: "Acme careers", snippet: "We're hiring!" }],
        cacheHit: false,
      })
      // tier 2: seniority_at_company — no salary data
      .mockResolvedValueOnce({
        results: [{ url: "https://example.com/2", title: "Acme reviews", snippet: "Good culture." }],
        cacheHit: false,
      })
      // tier 3: market_or_similar_companies — real salary data
      .mockResolvedValueOnce({
        results: [
          { url: "https://example.com/3", title: "Salary data", snippet: "Typical range is $100,000-$130,000/year." },
        ],
        cacheHit: false,
      });
    const fakeBroker = { execute: executeMock } as unknown as SearchBroker;
    const llm = new FakeLlmProvider({
      CompanySignalsAndSalary: [
        {
          positiveSignals: [],
          risks: [],
          salaryRange: "$100,000-$130,000/year",
          salarySource: "market_or_similar_companies",
          salarySourceNote: "Based on general market listings for this role.",
        },
      ],
    });
    const request = buildAgentRequest("run-3", AgentName.COMPANY_RESEARCH, {
      companyName: "Acme",
      vacancyTitle: "Senior Backend Engineer",
    });

    const response = await agent.run(request, { tracer, tools: { searchBroker: fakeBroker, llm } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(executeMock).toHaveBeenCalledTimes(4);
    expect(response.output.salaryInsight.source).toBe("market_or_similar_companies");
    expect(response.output.salaryInsight.sourceUrls).toEqual(["https://example.com/3"]);
  });
});
