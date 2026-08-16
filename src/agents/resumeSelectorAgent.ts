import { z } from "zod";
import { AgentName } from "../types/agent.js";
import { ResumeSelectionSchema } from "../types/application.js";
import { estimateCostUsd } from "../llm/pricing.js";
import { ResumeCandidateSchema } from "../tools/resumeLibrary.js";
import { BaseAgent, withPromptAddendum, type AgentExecutionContext } from "./baseAgent.js";

export const ResumeSelectorInputSchema = z.object({
  vacancyTitle: z.string(),
  vacancyRequirements: z.array(z.string()),
  vacancyKeywords: z.array(z.string()),
  missingSkills: z.array(z.string()),
  resumes: z.array(ResumeCandidateSchema),
});
export type ResumeSelectorInput = z.infer<typeof ResumeSelectorInputSchema>;

export const ResumeSelectorOutputSchema = ResumeSelectionSchema;
export type ResumeSelectorOutput = z.infer<typeof ResumeSelectorOutputSchema>;

/** Sentinel `selectedResumeId` for an empty Resume Library — orchestrator.ts checks for this to surface a warning instead of shipping a resume-less package with no explanation. */
export const NO_RESUME_IN_LIBRARY_ID = "no-resume-in-library";

const SYSTEM_PROMPT =
  "You are a resume-matching assistant. Given a vacancy's title/requirements/keywords and a " +
  "set of candidate resumes (by id and full text), choose the single best-matching resume " +
  "for this vacancy. Explain your reasoning by referencing specific resume content. Suggest " +
  "concrete modifications (what to add, emphasize, or reorder) grounded only in claims that " +
  "are genuinely supported by the chosen resume's text — never invent experience the resume " +
  "doesn't contain. Be brief: reasoning is a few sentences naming the specific matches that " +
  "decided it, not a full argument; each suggested modification is a short, actionable phrase.";

/**
 * Real resume-matching once the Resume Library (data/resumes/*.pdf) has at
 * least one file and Azure OpenAI is configured. Degrades gracefully, not
 * silently, when either is missing: an empty library returns a clear
 * "no-resume-in-library" result rather than fabricating a selection.
 */
export class ResumeSelectorAgent extends BaseAgent<ResumeSelectorInput, ResumeSelectorOutput> {
  readonly name = AgentName.RESUME_SELECTOR;
  readonly inputSchema = ResumeSelectorInputSchema;
  readonly outputSchema = ResumeSelectorOutputSchema;

  protected async execute(
    input: ResumeSelectorInput,
    ctx: AgentExecutionContext
  ): Promise<ResumeSelectorOutput> {
    if (input.resumes.length === 0) {
      return {
        selectedResumeId: NO_RESUME_IN_LIBRARY_ID,
        suggestedModifications: [],
        reasoning:
          "No resumes found in the Resume Library (data/resumes/*.pdf) — add at least one PDF resume to enable real selection.",
      };
    }

    return ctx.tools?.llm ? this.executeWithLlm(input, ctx) : this.executeStub(input);
  }

  private async executeWithLlm(
    input: ResumeSelectorInput,
    ctx: AgentExecutionContext
  ): Promise<ResumeSelectorOutput> {
    const startedAt = new Date().toISOString();
    const result = await ctx.tools!.llm!.generateStructured({
      consumer: AgentName.RESUME_SELECTOR,
      schemaName: "ResumeSelection",
      schema: ResumeSelectorOutputSchema,
      systemPrompt: withPromptAddendum(SYSTEM_PROMPT, ctx, this.name),
      userPrompt: JSON.stringify({
        vacancyTitle: input.vacancyTitle,
        vacancyRequirements: input.vacancyRequirements,
        vacancyKeywords: input.vacancyKeywords,
        missingSkills: input.missingSkills,
        resumes: input.resumes,
      }),
    });
    ctx.tracer.recordModelCall({
      agentName: this.name,
      model: result.model,
      tokenUsage: result.tokenUsage,
      estimatedCostUsd: estimateCostUsd(result.model, result.tokenUsage),
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return result.data;
  }

  private executeStub(input: ResumeSelectorInput): ResumeSelectorOutput {
    const first = input.resumes[0]!;
    return {
      selectedResumeId: first.id,
      suggestedModifications:
        input.missingSkills.length > 0
          ? input.missingSkills.map((skill) => `Add evidence addressing: ${skill}`)
          : ["No changes required — resume already covers the requirements"],
      reasoning: "Stub selection (no LLM configured): picked the first resume in the library.",
    };
  }
}
