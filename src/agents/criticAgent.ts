import { z } from "zod";
import { AgentName } from "../types/agent.js";
import { CriticPieceInputSchema, CriticPieceReviewSchema } from "../types/application.js";
import { estimateCostUsd } from "../llm/pricing.js";
import { BaseAgent, withPromptAddendum, type AgentExecutionContext } from "./baseAgent.js";
import { pick, pickPair, stableHash } from "./stubUtils.js";
import { countWords } from "./textMetrics.js";

export const CriticInputSchema = z.object({
  pieces: z.array(CriticPieceInputSchema),
  iteration: z.number().int().min(1).max(4),
  /**
   * The vacancy's own stated requirements/responsibilities — parallel to
   * WriterInputSchema's identically-named fields, so Critic can actually
   * enforce the vacancy-specificity Writer is asked to produce, not just
   * word count and generic weak-argument patterns. `.default([])` for the
   * same reason as Writer's: existing tests construct a CriticInput without
   * these two fields.
   */
  vacancyRequirements: z.array(z.string()).default([]),
  vacancyResponsibilities: z.array(z.string()).default([]),
  /** Whole-call setting, mirrors WriterInputSchema's identically-named field — see the SYSTEM_PROMPT note below. */
  humanizeStyle: z.boolean().default(false),
  /** Whole-call setting, mirrors WriterInputSchema's identically-named field — see the SYSTEM_PROMPT note below. */
  avoidOverfitting: z.boolean().default(false),
  /** Test-fixture-only flag, ignored once a real LLM is wired in: forces iterations 3+ to stay unconverged in stub mode, to prove the hard cap engages. */
  forceNoConvergence: z.boolean().default(false),
});
export type CriticInput = z.infer<typeof CriticInputSchema>;

/**
 * Agent-level output — unaware of the writer/critic loop's "progressive
 * locking" bookkeeping (iteration/converged are added by the loop itself, see
 * writerCriticLoop.ts and types/application.ts's LockedPieceReviewSchema).
 * No top-level aggregate score: an LLM-averaged number across unrelated
 * content (a cover letter and a "describe a product" answer) is meaningless —
 * any aggregate is computed in code from the per-piece scores if ever needed.
 */
export const CriticOutputSchema = z.object({
  pieceReviews: z.array(CriticPieceReviewSchema),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

const SYSTEM_PROMPT =
  "You are a skeptical hiring-application critic. You are given several independent pieces of " +
  "writing to review together (a cover letter and, often, one or more application-question " +
  "answers) — review EACH piece on its own merits and return one review per piece, keyed by its " +
  "`pieceId`. For each piece, look for weak arguments, exaggerations, unsupported claims, " +
  "generic filler, and ATS issues (missing role-relevant keywords). Each piece includes its " +
  "actual word/character count (in `rangeUnit`) and its target range — flag it as a 'major' " +
  "issue if it falls outside that range (too short reads as low-effort, too long risks losing " +
  "the reader, or exceeding a hard character limit risks outright rejection by the application " +
  "system). If vacancyRequirements or vacancyResponsibilities are given, flag as a 'major' issue " +
  "any piece that reads generically and doesn't meaningfully engage with what this specific role " +
  "actually asks for — but a piece that quotes a requirement/responsibility verbatim instead of " +
  "engaging with it naturally is just as much a specificity failure, and should be flagged too. " +
  "If a piece's `guidance` is given, that's the candidate's own explicit request for what to make " +
  "sure this piece covers — do not penalize a piece for engaging with its own guidance even if it " +
  "reads as slightly tangential to the vacancy's stated requirements; only flag it if the piece " +
  "ignored the guidance entirely, or is otherwise weak on its own merits. If humanizeStyle is " +
  "true, do not flag a deliberately short/blunt sentence or uneven rhythm as weak on its own — " +
  "that's an intentional stylistic choice; still flag a piece that still reads as a neat " +
  "three-item list or leans on generic AI transition-phrase padding, since that's exactly what " +
  "humanizeStyle is asking to avoid. If avoidOverfitting is true, do not penalize a piece for " +
  "reading as broadly professional rather than hyper-mirrored to the posting's own wording — " +
  "not echoing the posting's exact phrasing back is intentional there; still flag genuinely " +
  "generic, unsubstantiated filler on its own merits. " +
  "Never rewrite anything — return only, per piece, a structured list of issues " +
  "(severity: critical/major/minor) and a 0-100 quality score. Be strict: only give a score of " +
  "75 or higher if that piece is specific, evidence-based, free of critical issues, and within " +
  "its target range. You MUST return exactly one review per piece you were given, using the " +
  "same `pieceId` values — never omit a piece or invent one that wasn't given to you.";

function actualCount(piece: z.infer<typeof CriticPieceInputSchema>): number {
  return piece.rangeUnit === "characters" ? piece.text.length : countWords(piece.text);
}

// Stub-only issue banks (never seen by the real LLM path) — varied per piece
// via stableHash so two pieces in the same response don't read the exact
// same copy-pasted critique. Severity counts and score bands are deliberately
// fixed by iteration (see executeStub below): the writer/critic loop's
// progressive-locking tests depend on iteration 1 always blocking on critical
// issues, iteration 2 always landing below the convergence threshold, and
// iteration 3+ always converging unless forceNoConvergence.
const CRITICAL_ISSUE_BANK = [
  "Reads generically — doesn't yet connect to anything specific about this company or role.",
  "Claims relevant experience without a concrete example or number to back it up.",
  "Opens with a stock phrase that could be pasted into almost any application.",
  "States an accomplishment without saying what the actual outcome was.",
  "Doesn't reference anything specific from the job posting itself.",
];

const MAJOR_ISSUE_BANK = [
  "One section repeats a point already made earlier in the piece.",
  "Drifts into generic language in the middle instead of staying concrete.",
  "Could tie back to the role's actual requirements more directly.",
  "Runs a bit long for how much new information it actually adds.",
  "The closing feels tacked-on rather than a natural wrap-up.",
];

/**
 * Never rewrites — only critiques, per README. Defaults to the pricier model
 * (LLM_MODEL_CRITIC, falling back to LLM_MODEL_DEFAULT) since catching weak
 * arguments/exaggerations/unsupported claims across every piece benefits from
 * stronger reasoning than drafting does.
 *
 * Stub fallback (used whenever no LLM is configured, e.g. in tests) is
 * deterministic BY ITERATION, applied identically to every piece, so the
 * writer/critic loop's early-stopping/locking stays observable without a real
 * model call: iteration 1 has 2 critical issues, iteration 2 has 1 major
 * issue, iteration 3+ is clean (unless forceNoConvergence).
 */
export class CriticAgent extends BaseAgent<CriticInput, CriticOutput> {
  readonly name = AgentName.CRITIC;
  readonly inputSchema = CriticInputSchema;
  readonly outputSchema = CriticOutputSchema;

  protected async execute(input: CriticInput, ctx: AgentExecutionContext): Promise<CriticOutput> {
    return ctx.tools?.llm ? this.executeWithLlm(input, ctx) : this.executeStub(input);
  }

  private async executeWithLlm(input: CriticInput, ctx: AgentExecutionContext): Promise<CriticOutput> {
    const startedAt = new Date().toISOString();
    const result = await ctx.tools!.llm!.generateStructured({
      consumer: AgentName.CRITIC,
      schemaName: "CriticReview",
      schema: CriticOutputSchema,
      systemPrompt: withPromptAddendum(SYSTEM_PROMPT, ctx, this.name),
      userPrompt: JSON.stringify({
        pieces: input.pieces.map((piece) => ({
          pieceId: piece.id,
          label: piece.label,
          text: piece.text,
          rangeUnit: piece.rangeUnit,
          actualCount: actualCount(piece),
          minWords: piece.minWords,
          max: piece.max,
          guidance: piece.guidance,
        })),
        vacancyRequirements: input.vacancyRequirements,
        vacancyResponsibilities: input.vacancyResponsibilities,
        humanizeStyle: input.humanizeStyle,
        avoidOverfitting: input.avoidOverfitting,
      }),
    });
    ctx.tracer.recordModelCall({
      agentName: this.name,
      model: result.model,
      tokenUsage: result.tokenUsage,
      estimatedCostUsd: estimateCostUsd(result.model, result.tokenUsage),
      iteration: input.iteration,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return result.data;
  }

  private executeStub(input: CriticInput): CriticOutput {
    const reviewFor = (pieceId: string): CriticOutput["pieceReviews"][number] => {
      const seed = stableHash(`${pieceId}:${input.iteration}`);
      if (input.iteration === 1) {
        const [first, second] = pickPair(CRITICAL_ISSUE_BANK, seed);
        return {
          pieceId,
          issues: [
            { severity: "critical", description: first },
            { severity: "critical", description: second },
          ],
          qualityScore: 35 + (seed % 20),
        };
      }
      if (input.iteration === 2) {
        return {
          pieceId,
          issues: [{ severity: "major", description: pick(MAJOR_ISSUE_BANK, seed) }],
          qualityScore: 60 + (seed % 13),
        };
      }
      if (input.forceNoConvergence) {
        return {
          pieceId,
          issues: [{ severity: "major", description: `${pick(MAJOR_ISSUE_BANK, seed)} (still not quite there)` }],
          qualityScore: 65 + (seed % 9),
        };
      }
      return { pieceId, issues: [], qualityScore: 80 + (seed % 13) };
    };

    return { pieceReviews: input.pieces.map((piece) => reviewFor(piece.id)) };
  }
}
