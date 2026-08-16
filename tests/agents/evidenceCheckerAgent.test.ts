import { describe, expect, it } from "vitest";
import { EvidenceCheckerAgent } from "../../src/agents/evidenceCheckerAgent.js";
import { buildAgentRequest } from "../../src/agents/baseAgent.js";
import { AgentName } from "../../src/types/agent.js";
import { Tracer } from "../../src/observability/tracer.js";
import { FakeLlmProvider } from "../helpers/fakeLlmProvider.js";

describe("EvidenceCheckerAgent", () => {
  it("returns an honestly empty result when there is no resume to check claims against", async () => {
    const agent = new EvidenceCheckerAgent();
    const tracer = new Tracer("run-1");
    const request = buildAgentRequest("run-1", AgentName.EVIDENCE_CHECKER, {
      pieces: [{ id: "cover_letter", label: "Cover Letter", text: "I led a team of 10 engineers." }],
    });

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output).toEqual({ pieceResults: [] });
  });

  it("returns an honestly empty result when a resume exists but no LLM is configured", async () => {
    const agent = new EvidenceCheckerAgent();
    const tracer = new Tracer("run-2");
    const request = buildAgentRequest("run-2", AgentName.EVIDENCE_CHECKER, {
      pieces: [{ id: "cover_letter", label: "Cover Letter", text: "I led a team of 10 engineers." }],
      candidateResumeText: "Team Lead, ExampleCorp, 2020-2023.",
    });

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output).toEqual({ pieceResults: [] });
  });

  it("checks claims for every piece against the real resume text when both an LLM and a resume are available", async () => {
    const agent = new EvidenceCheckerAgent();
    const tracer = new Tracer("run-3");
    const llm = new FakeLlmProvider({
      EvidenceMap: [
        {
          pieceResults: [
            {
              pieceId: "cover_letter",
              entries: [
                { claim: "led a team of 10 engineers", evidence: ["Team Lead, ExampleCorp"], supported: true },
                { claim: "grew revenue by 200%", evidence: [], supported: false },
              ],
              unsupportedClaims: ["grew revenue by 200%"],
            },
            {
              pieceId: "q1",
              entries: [],
              unsupportedClaims: [],
            },
          ],
        },
      ],
    });
    const request = buildAgentRequest("run-3", AgentName.EVIDENCE_CHECKER, {
      pieces: [
        { id: "cover_letter", label: "Cover Letter", text: "I led a team of 10 engineers and grew revenue by 200%." },
        { id: "q1", label: "Why this role?", text: "Because I love it." },
      ],
      candidateResumeText: "Team Lead, ExampleCorp, 2020-2023.",
    });

    const response = await agent.run(request, { tracer, tools: { llm } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.pieceResults.map((r) => r.pieceId).sort()).toEqual(["cover_letter", "q1"]);
    const coverLetterResult = response.output.pieceResults.find((r) => r.pieceId === "cover_letter");
    expect(coverLetterResult?.unsupportedClaims).toEqual(["grew revenue by 200%"]);
    expect(llm.calls[0]?.schemaName).toBe("EvidenceMap");
    expect(tracer.flush().some((e) => e.eventType === "model_call" && e.agentName === "EVIDENCE_CHECKER")).toBe(
      true
    );
  });
});
