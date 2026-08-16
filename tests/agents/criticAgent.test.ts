import { describe, expect, it } from "vitest";
import { CriticAgent } from "../../src/agents/criticAgent.js";
import { buildAgentRequest } from "../../src/agents/baseAgent.js";
import { AgentName } from "../../src/types/agent.js";
import { Tracer } from "../../src/observability/tracer.js";
import { FakeLlmProvider } from "../helpers/fakeLlmProvider.js";

describe("CriticAgent", () => {
  it("falls back to the deterministic per-iteration stub when no LLM is configured", async () => {
    const agent = new CriticAgent();
    const tracer = new Tracer("run-1");
    const request = buildAgentRequest(
      "run-1",
      AgentName.CRITIC,
      {
        pieces: [
          { id: "cover_letter", label: "Cover Letter", text: "Dear Acme, ...", rangeUnit: "words", minWords: 200, max: 450 },
        ],
        iteration: 1,
        forceNoConvergence: false,
      },
      { iteration: 1 }
    );

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.pieceReviews).toHaveLength(1);
    expect(response.output.pieceReviews[0]?.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("reviews every piece it's given and returns one review per pieceId", async () => {
    const agent = new CriticAgent();
    const tracer = new Tracer("run-1b");
    const request = buildAgentRequest(
      "run-1b",
      AgentName.CRITIC,
      {
        pieces: [
          { id: "cover_letter", label: "Cover Letter", text: "Dear Acme, ...", rangeUnit: "words", minWords: 200, max: 450 },
          { id: "q1", label: "Why this role?", text: "Because...", rangeUnit: "words", max: 150 },
        ],
        iteration: 3,
        forceNoConvergence: false,
      },
      { iteration: 3 }
    );

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.pieceReviews.map((r) => r.pieceId).sort()).toEqual(["cover_letter", "q1"]);
  });

  it("uses the LLM as the CRITIC consumer and ignores forceNoConvergence when configured", async () => {
    const agent = new CriticAgent();
    const tracer = new Tracer("run-2");
    const llm = new FakeLlmProvider({
      CriticReview: [{ pieceReviews: [{ pieceId: "cover_letter", issues: [], qualityScore: 91 }] }],
    });
    const request = buildAgentRequest(
      "run-2",
      AgentName.CRITIC,
      {
        pieces: [
          { id: "cover_letter", label: "Cover Letter", text: "Dear Acme, ...", rangeUnit: "words", minWords: 200, max: 450 },
        ],
        iteration: 1,
        forceNoConvergence: true,
      },
      { iteration: 1 }
    );

    const response = await agent.run(request, { tracer, tools: { llm } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.pieceReviews[0]?.qualityScore).toBe(91);
    expect(llm.calls[0]?.consumer).toBe(AgentName.CRITIC);
    expect(llm.calls[0]?.schemaName).toBe("CriticReview");
    expect(tracer.flush().some((e) => e.eventType === "model_call" && e.agentName === "CRITIC")).toBe(true);
  });

  it("passes vacancyRequirements/vacancyResponsibilities through to the LLM prompt, when given", async () => {
    const agent = new CriticAgent();
    const tracer = new Tracer("run-3");
    const llm = new FakeLlmProvider({
      CriticReview: [{ pieceReviews: [{ pieceId: "cover_letter", issues: [], qualityScore: 91 }] }],
    });
    const request = buildAgentRequest(
      "run-3",
      AgentName.CRITIC,
      {
        pieces: [
          { id: "cover_letter", label: "Cover Letter", text: "Dear Acme, ...", rangeUnit: "words", minWords: 200, max: 450 },
        ],
        iteration: 1,
        vacancyRequirements: ["5+ years of backend experience"],
        vacancyResponsibilities: ["Own the payments platform roadmap"],
        humanizeStyle: true,
        forceNoConvergence: false,
      },
      { iteration: 1 }
    );

    const response = await agent.run(request, { tracer, tools: { llm } });

    expect(response.status).toBe("ok");
    expect(llm.calls[0]?.userPrompt).toContain("5+ years of backend experience");
    expect(llm.calls[0]?.userPrompt).toContain("Own the payments platform roadmap");
    expect((JSON.parse(llm.calls[0]!.userPrompt as string) as { humanizeStyle: boolean }).humanizeStyle).toBe(true);
  });

  it("passes a piece's guidance through to the LLM prompt, when given", async () => {
    const agent = new CriticAgent();
    const tracer = new Tracer("run-4");
    const llm = new FakeLlmProvider({
      CriticReview: [{ pieceReviews: [{ pieceId: "q1", issues: [], qualityScore: 91 }] }],
    });
    const request = buildAgentRequest(
      "run-4",
      AgentName.CRITIC,
      {
        pieces: [{ id: "q1", label: "Why?", text: "Because...", rangeUnit: "words", max: 150, guidance: "Mention my open-source work" }],
        iteration: 1,
        forceNoConvergence: false,
      },
      { iteration: 1 }
    );

    const response = await agent.run(request, { tracer, tools: { llm } });

    expect(response.status).toBe("ok");
    expect(llm.calls[0]?.userPrompt).toContain("Mention my open-source work");
  });
});
