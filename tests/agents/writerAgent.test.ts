import { describe, expect, it } from "vitest";
import { WriterAgent } from "../../src/agents/writerAgent.js";
import { buildAgentRequest } from "../../src/agents/baseAgent.js";
import { AgentName } from "../../src/types/agent.js";
import { Tracer } from "../../src/observability/tracer.js";
import { FakeLlmProvider } from "../helpers/fakeLlmProvider.js";

const TEST_LIMITS = { coverLetterMinWords: 200, coverLetterMaxWords: 450, answerMaxWords: 150 };

describe("WriterAgent", () => {
  it("falls back to the deterministic stub when no LLM is configured", async () => {
    const agent = new WriterAgent();
    const tracer = new Tracer("run-1");
    const request = buildAgentRequest("run-1", AgentName.WRITER, {
      vacancyTitle: "Senior Engineer",
      companyName: "Acme",
      strengths: ["Backend systems"],
      limits: TEST_LIMITS,
    });

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.coverLetter).toContain("Acme");
    expect(response.output.applicationAnswers).toHaveLength(0);
    expect(tracer.flush().some((e) => e.eventType === "model_call")).toBe(false);
  });

  it("produces one stub answer per requested question, echoing back each id", async () => {
    const agent = new WriterAgent();
    const tracer = new Tracer("run-1b");
    const request = buildAgentRequest("run-1b", AgentName.WRITER, {
      vacancyTitle: "Senior Engineer",
      companyName: "Acme",
      strengths: ["Backend systems"],
      applicationQuestions: [
        { id: "q1", question: "Why this role?" },
        { id: "q2", question: "Describe a product you're proud of." },
      ],
      limits: TEST_LIMITS,
    });

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.applicationAnswers.map((a) => a.id).sort()).toEqual(["q1", "q2"]);
  });

  it("weaves the first vacancy requirement into the stub cover letter, when given, without an LLM", async () => {
    const agent = new WriterAgent();
    const tracer = new Tracer("run-1c");
    const request = buildAgentRequest("run-1c", AgentName.WRITER, {
      vacancyTitle: "Senior Engineer",
      companyName: "Acme",
      strengths: ["Backend systems"],
      vacancyRequirements: ["5+ years of distributed systems experience"],
      limits: TEST_LIMITS,
    });

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.coverLetter).toContain("5+ years of distributed systems experience");
  });

  it("grounds the draft in the selected resume text and passes style/answer examples through, when an LLM is configured", async () => {
    const agent = new WriterAgent();
    const tracer = new Tracer("run-2");
    const llm = new FakeLlmProvider({
      WriterOutput: [
        {
          coverLetter: "Dear Acme, ... Sincerely, Candidate",
          applicationAnswers: [{ id: "q1", question: "Why do you want this role?", answer: "Because." }],
        },
      ],
    });
    const request = buildAgentRequest("run-2", AgentName.WRITER, {
      vacancyTitle: "Senior Engineer",
      companyName: "Acme",
      strengths: ["Backend systems"],
      candidateResumeText: "5 years building backend systems at ExampleCorp.",
      styleExamples: ["I've spent the last few years building distributed systems."],
      pastAnswerExamples: ["Q: What motivates you?\nA: Solving hard problems."],
      vacancyRequirements: ["5+ years of backend experience"],
      vacancyResponsibilities: ["Own the payments platform roadmap"],
      applicationQuestions: [{ id: "q1", question: "Why do you want this role?", guidance: "Mention my open-source work" }],
      coverLetterGuidance: "Mention my conference talks",
      humanizeStyle: true,
      limits: { coverLetterMinWords: 100, coverLetterMaxWords: 200, answerMaxWords: 50 },
    });

    const response = await agent.run(request, { tracer, tools: { llm } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.coverLetter).toBe("Dear Acme, ... Sincerely, Candidate");
    expect(llm.calls[0]?.schemaName).toBe("WriterOutput");
    expect(llm.calls[0]?.userPrompt).toContain("ExampleCorp");
    expect(llm.calls[0]?.userPrompt).toContain("distributed systems");
    expect(llm.calls[0]?.userPrompt).toContain("Solving hard problems");
    expect(llm.calls[0]?.userPrompt).toContain("5+ years of backend experience");
    expect(llm.calls[0]?.userPrompt).toContain("Own the payments platform roadmap");
    expect(llm.calls[0]?.userPrompt).toContain("Mention my open-source work");
    expect(llm.calls[0]?.userPrompt).toContain("Mention my conference talks");
    expect((JSON.parse(llm.calls[0]!.userPrompt as string) as { humanizeStyle: boolean }).humanizeStyle).toBe(true);
    // The per-call limits (not env defaults) must actually reach the prompt.
    expect(llm.calls[0]?.systemPrompt).toContain("between 100 and 200 words");
    expect(llm.calls[0]?.systemPrompt).toContain("under 50 words");
    expect(tracer.flush().some((e) => e.eventType === "model_call" && e.agentName === "WRITER")).toBe(true);
  });
});
