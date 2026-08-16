import { z } from "zod";
import { AgentName } from "../types/agent.js";
import { EvidenceMapSchema, PieceInputSchema } from "../types/application.js";
import { estimateCostUsd } from "../llm/pricing.js";
import { BaseAgent, withPromptAddendum, type AgentExecutionContext } from "./baseAgent.js";

export const EvidenceCheckerInputSchema = z.object({
  pieces: z.array(PieceInputSchema),
  /** The resume Resume Selector chose, if any — the only source claims can be checked against. */
  candidateResumeText: z.string().optional(),
});
export type EvidenceCheckerInput = z.infer<typeof EvidenceCheckerInputSchema>;

export const EvidenceCheckerOutputSchema = EvidenceMapSchema;
export type EvidenceCheckerOutput = z.infer<typeof EvidenceCheckerOutputSchema>;

const SYSTEM_PROMPT =
  "You are an evidence-checking assistant. You are given several independent pieces of writing " +
  "(a cover letter and, often, one or more application-question answers) — check EACH piece on " +
  "its own and return one result per piece, keyed by its `pieceId`. For each piece, identify " +
  "every significant factual or experience claim made in it (an accomplishment, a skill, a " +
  "number, a role, an employer). For each claim, check whether it is genuinely supported by the " +
  "given resume text. If supported, quote or closely paraphrase the specific resume evidence. " +
  "If not supported, mark it unsupported — never invent evidence that isn't in the resume text. " +
  "You MUST return exactly one result per piece you were given, using the same `pieceId` " +
  "values — never omit a piece or invent one that wasn't given to you. Be brief: state each " +
  "claim and its matching evidence as short phrases, not full sentences re-explaining the match.";

/**
 * Every significant claim in every piece (cover letter and every generated
 * answer — not just the cover letter) should be backed by actual experience/
 * evidence, per README's example (e.g. "Led AI strategy" -> Legal Assistant,
 * MonShare, Cedro). Real once both an LLM and a selected resume are
 * available. Without a resume to check against, there is nothing to verify
 * claims against — this returns an honestly empty result rather than
 * fabricating a check.
 */
export class EvidenceCheckerAgent extends BaseAgent<EvidenceCheckerInput, EvidenceCheckerOutput> {
  readonly name = AgentName.EVIDENCE_CHECKER;
  readonly inputSchema = EvidenceCheckerInputSchema;
  readonly outputSchema = EvidenceCheckerOutputSchema;

  protected async execute(
    input: EvidenceCheckerInput,
    ctx: AgentExecutionContext
  ): Promise<EvidenceCheckerOutput> {
    if (ctx.tools?.llm && input.candidateResumeText) {
      return this.executeWithLlm(input, ctx);
    }
    return { pieceResults: [] };
  }

  private async executeWithLlm(
    input: EvidenceCheckerInput,
    ctx: AgentExecutionContext
  ): Promise<EvidenceCheckerOutput> {
    const startedAt = new Date().toISOString();
    const result = await ctx.tools!.llm!.generateStructured({
      consumer: AgentName.EVIDENCE_CHECKER,
      schemaName: "EvidenceMap",
      schema: EvidenceCheckerOutputSchema,
      systemPrompt: withPromptAddendum(SYSTEM_PROMPT, ctx, this.name),
      userPrompt: JSON.stringify({
        pieces: input.pieces.map((p) => ({ pieceId: p.id, label: p.label, text: p.text })),
        resumeText: input.candidateResumeText,
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
}
