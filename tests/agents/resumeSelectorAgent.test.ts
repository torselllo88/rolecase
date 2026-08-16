import { describe, expect, it } from "vitest";
import { ResumeSelectorAgent } from "../../src/agents/resumeSelectorAgent.js";
import { buildAgentRequest } from "../../src/agents/baseAgent.js";
import { AgentName } from "../../src/types/agent.js";
import { Tracer } from "../../src/observability/tracer.js";
import { FakeLlmProvider } from "../helpers/fakeLlmProvider.js";

const BASE_INPUT = {
  vacancyTitle: "Senior Engineer",
  vacancyRequirements: ["Python"],
  vacancyKeywords: ["python"],
  missingSkills: [] as string[],
};

describe("ResumeSelectorAgent", () => {
  it("returns an honest no-resume result instead of fabricating a selection when the library is empty", async () => {
    const agent = new ResumeSelectorAgent();
    const tracer = new Tracer("run-1");
    const request = buildAgentRequest("run-1", AgentName.RESUME_SELECTOR, {
      ...BASE_INPUT,
      resumes: [],
    });

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.selectedResumeId).toBe("no-resume-in-library");
  });

  it("falls back to picking the first resume when resumes exist but no LLM is configured", async () => {
    const agent = new ResumeSelectorAgent();
    const tracer = new Tracer("run-2");
    const request = buildAgentRequest("run-2", AgentName.RESUME_SELECTOR, {
      ...BASE_INPUT,
      resumes: [
        { id: "resume-a", fileName: "resume-a.pdf", text: "Python developer" },
        { id: "resume-b", fileName: "resume-b.pdf", text: "Java developer" },
      ],
    });

    const response = await agent.run(request, { tracer });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.selectedResumeId).toBe("resume-a");
  });

  it("uses the LLM to pick a resume grounded in real resume text when configured", async () => {
    const agent = new ResumeSelectorAgent();
    const tracer = new Tracer("run-3");
    const llm = new FakeLlmProvider({
      ResumeSelection: [
        {
          selectedResumeId: "resume-b",
          suggestedModifications: ["Emphasize the Django project"],
          reasoning: "resume-b explicitly lists Python/Django experience matching the vacancy.",
        },
      ],
    });
    const request = buildAgentRequest("run-3", AgentName.RESUME_SELECTOR, {
      ...BASE_INPUT,
      resumes: [
        { id: "resume-a", fileName: "resume-a.pdf", text: "Java developer" },
        { id: "resume-b", fileName: "resume-b.pdf", text: "Python/Django developer" },
      ],
    });

    const response = await agent.run(request, { tracer, tools: { llm } });

    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.output.selectedResumeId).toBe("resume-b");
    expect(llm.calls[0]?.schemaName).toBe("ResumeSelection");
    expect(tracer.flush().some((e) => e.eventType === "model_call" && e.agentName === "RESUME_SELECTOR")).toBe(
      true
    );
  });
});
