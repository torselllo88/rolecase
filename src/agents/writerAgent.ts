import { z } from "zod";
import { AgentName } from "../types/agent.js";
import { estimateCostUsd } from "../llm/pricing.js";
import { BaseAgent, withPromptAddendum, type AgentExecutionContext } from "./baseAgent.js";
import { capitalize, joinNaturally, lowerFirst, pick, stableHash } from "./stubUtils.js";

const WriterLimitsSchema = z.object({
  coverLetterMinWords: z.number().int().positive(),
  coverLetterMaxWords: z.number().int().positive(),
  answerMaxWords: z.number().int().positive(),
});

export const WriterQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  maxCharacters: z.number().int().positive().optional(),
  labelSuggestsLongForm: z.boolean().optional(),
  /** The candidate's own note on what this answer should make sure to cover — see BODY_INSTRUCTIONS. */
  guidance: z.string().optional(),
});
export type WriterQuestion = z.infer<typeof WriterQuestionSchema>;

export const WriterAnswerSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
});
export type WriterAnswer = z.infer<typeof WriterAnswerSchema>;

export const WriterInputSchema = z.object({
  vacancyTitle: z.string(),
  companyName: z.string(),
  strengths: z.array(z.string()),
  /**
   * Per-piece feedback from the previous iteration, keyed by pieceId — replaces
   * the old flat `priorIssues: string[]`. A flat list couldn't say *which*
   * piece (cover letter vs. which specific answer) an issue was about, so
   * Writer had no reliable way to know what to revise. Only pieces still being
   * revised carry entries here; converged/locked pieces are simply absent from
   * `applicationQuestions` on later iterations, so there's nothing to revise.
   */
  priorIssuesByPieceId: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * Body excerpts from the candidate's own past cover letters (no greeting/
   * sign-off expected), for style/voice reference only — see CoverLetterLibrary.
   */
  styleExamples: z.array(z.string()).default([]),
  /**
   * Past question->answer pairs from AnswerExampleLibrary, formatted as
   * "Q: ...\nA: ..." blocks — grounding only, same "match content/style, adapt
   * to the real question, never invent" framing as styleExamples.
   */
  pastAnswerExamples: z.array(z.string()).default([]),
  /**
   * Full text of the resume Resume Selector chose (see ResumeLibrary), when
   * one exists — the primary grounding source. `strengths` (from the still-
   * stubbed fit analysis) is only a fallback hint when no resume is available.
   */
  candidateResumeText: z.string().optional(),
  /**
   * The vacancy's own stated requirements/responsibilities (see
   * NormalizedVacancySchema) — grounds letters/answers in what THIS role
   * actually asks for, not just its title/company. `.default([])`, matching
   * every other array field on this schema, so existing tests that construct
   * a WriterInput without these two new fields keep passing schema validation.
   */
  vacancyRequirements: z.array(z.string()).default([]),
  vacancyResponsibilities: z.array(z.string()).default([]),
  /**
   * The questions Writer must answer this call — union of extracted-and-
   * filtered form fields and manually-entered ones (see Orchestrator.generate()).
   * On iterations after the first, only contains questions whose piece hasn't
   * converged/locked yet (see writerCriticLoop.ts's progressive locking) — an
   * empty array (or no detected/manual questions at all) is valid and means
   * zero application answers, not a hardcoded filler question.
   */
  applicationQuestions: z.array(WriterQuestionSchema).default([]),
  /**
   * Whether Writer should produce a cover letter this call. False once the
   * cover-letter piece has already converged/locked in an earlier iteration
   * (see writerCriticLoop.ts) — without this, Writer would keep regenerating
   * (and the loop would keep discarding) a cover letter that's already good,
   * defeating the entire point of progressive locking for that piece.
   */
  includeCoverLetter: z.boolean().default(true),
  /** The candidate's own note on what the cover letter should make sure to cover — see BODY_INSTRUCTIONS. Only meaningful while includeCoverLetter is true. */
  coverLetterGuidance: z.string().optional(),
  /** Whole-call setting (applies to every piece uniformly) — see BODY_INSTRUCTIONS. */
  humanizeStyle: z.boolean().default(false),
  /** Whole-call setting, mirrors humanizeStyle — see BODY_INSTRUCTIONS. */
  avoidOverfitting: z.boolean().default(false),
  /**
   * Always the effective, already-resolved limits (per-run override merged
   * with env defaults — see config/env.ts's resolveWriterLimits()). This
   * agent never reads env directly, so there is exactly one place a caller
   * can disagree about what limits apply to a given call: whatever it passes
   * here.
   */
  limits: WriterLimitsSchema,
});
export type WriterInput = z.infer<typeof WriterInputSchema>;

export const WriterOutputSchema = z.object({
  /**
   * `null` (never absent) when `includeCoverLetter` was false — already
   * locked, not re-requested. Modeled as nullable rather than optional
   * because OpenAI's (and OpenRouter's passthrough) structured-outputs API
   * requires every property to be present in the schema's `required` list;
   * a genuinely optional/absent key is rejected at the API level, so "no
   * value" has to be represented by `null` instead of by omission.
   */
  coverLetter: z.string().nullable(),
  applicationAnswers: z.array(WriterAnswerSchema),
});
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

const BODY_INSTRUCTIONS =
  "Be specific and avoid generic filler. If candidateResumeText is " +
  "given, it is the primary source of truth — ground every claim in it, citing specific real " +
  "accomplishments, numbers, employers, and technologies that actually appear in it, chosen " +
  "for relevance to the vacancy. If candidateResumeText is absent, fall back to the plain " +
  "qualitative candidateStrengths list and do NOT invent specific numbers, percentages, " +
  "employer names, team sizes, or timeframes that weren't provided — describe strengths " +
  "qualitatively instead of fabricating a statistic to sound impressive. If prior critique is " +
  "given for a piece, directly address every point raised for that piece instead of making " +
  "cosmetic edits. If styleReferenceCoverLetters examples are given, note that they are BODY " +
  "TEXT ONLY — no greeting or sign-off included. Use them only to match the candidate's own " +
  "tone, sentence rhythm, and vocabulary in the body of the letter you write; never copy their " +
  "specific content or claims. Regardless of whether examples are given, always produce a " +
  "complete, properly formatted cover letter with an appropriate greeting (e.g. \"Dear Hiring " +
  "Team\") and sign-off — do not omit them just because the reference examples lack them. If " +
  "pastAnswerExamples are given, they show how this candidate has answered *different* " +
  "questions before — match their content/style where genuinely relevant, but always adapt to " +
  "the real question asked; never copy an example's specific content verbatim or invent an " +
  "answer to a question that wasn't asked. For each entry in applicationQuestions, answer only " +
  "that exact question, echo back its exact `id`, and respect any per-question length guidance " +
  "(if a question's labelSuggestsLongForm is true, write a fuller answer even without a strict " +
  "character limit). If vacancyRequirements or vacancyResponsibilities are given, ground specific " +
  "points in them — connect the candidate's real experience to what THIS role actually asks for, " +
  "not just its title and company, so the writing reads as targeted rather than generic. Never " +
  "quote or restate a requirement/responsibility verbatim as if reciting the posting back — " +
  "reference what it implies about the role naturally, in your own words. If a question's " +
  "`guidance`, or the top-level `coverLetterGuidance` for the cover letter, is given, it is the " +
  "candidate's own explicit note on what they want that piece to make sure to mention or " +
  "emphasize — address it directly and substantively, not just gesture at it in passing. If " +
  "humanizeStyle is true, deliberately avoid common AI-writing tells: don't structure " +
  "reasons or lists as neat three-item sets (\"X, Y, and Z\"); vary sentence length " +
  "noticeably rather than keeping a uniform rhythm; avoid generic transition phrases " +
  "(\"Moreover\", \"Furthermore\", \"In today's...\"); avoid overused AI vocabulary " +
  "(\"delve\", \"tapestry\", \"testament to\", \"leverage\"/\"navigate\" used loosely) — an " +
  "occasional short, blunt sentence is good, not a flaw. If avoidOverfitting is true, do not " +
  "mirror the vacancy posting's own buzzwords/exact phrasing back at it, and do not frame the " +
  "candidate as a uniquely perfect match for this one specific listing — write with natural, " +
  "understated confidence, the way a strong candidate would write for any similar role, rather " +
  "than performing enthusiasm for this posting; still ground every claim in real experience, " +
  "just without echoing the posting's own words to prove the fit. If " +
  "includeCoverLetter is false, do not write a cover letter at all (omit " +
  "the field) — it has already been finalized in an earlier round and revisiting it would be " +
  "wasted effort; spend your full attention on the requested applicationQuestions.";

function buildSystemPrompt(limits: z.infer<typeof WriterLimitsSchema>): string {
  const { coverLetterMinWords, coverLetterMaxWords, answerMaxWords } = limits;
  return (
    "You are a career coach writing a tailored cover letter and any requested application-" +
    "question answers for a job seeker. " +
    `Write the cover letter body between ${coverLetterMinWords} and ${coverLetterMaxWords} ` +
    "words — long enough to be substantive, short enough to respect the reader's time. Keep " +
    `each application answer under ${answerMaxWords} words unless a stricter character limit is ` +
    "given for that specific question. Never pad length with filler to hit the minimum — cut a " +
    "real point short instead of pushing past the maximum. " +
    BODY_INSTRUCTIONS
  );
}

// Stub-only template banks (never seen by the real LLM path) — picked
// deterministically by stableHash so the same inputs always produce the same
// output, but different vacancies/questions read as genuinely different text
// rather than one hardcoded sentence repeated everywhere.
const OPENING_BANK: ((title: string, company: string) => string)[] = [
  (title, company) => `I'm writing to apply for the ${title} role at ${company}.`,
  (title, company) => `I came across the ${title} opening at ${company} and wanted to apply directly.`,
  (title, company) => `The ${title} role at ${company} looks like a strong match for my background.`,
  (title, company) => `I'd like to be considered for the ${title} position at ${company}.`,
];

const STRENGTH_LEAD_BANK: ((s: string) => string)[] = [
  (s) => `My background includes ${s}`,
  (s) => `I bring hands-on experience in ${s}`,
  (s) => `A core part of my experience is ${s}`,
  (s) => `I've spent much of my career focused on ${s}`,
];

const CLOSING_BANK = [
  "I'd welcome the chance to discuss how I could contribute to the team.",
  "I'd be glad to talk through how my background fits what you're looking for.",
  "I'm happy to share more detail on any of this in conversation.",
  "I'd love the opportunity to talk this through further.",
];

const ANSWER_TEMPLATE_BANK: ((strength: string) => string)[] = [
  (s) =>
    `My experience in ${s} is directly relevant here — it's given me practical exposure to the kind of work this question is getting at.`,
  (s) => `${capitalize(s)} has been a consistent focus in my work, and it's shaped how I'd approach this.`,
  (s) => `I'd point to my experience in ${s} as the clearest example — it's given me a solid foundation for this.`,
  (s) => `This connects to my background in ${s}, which I've built up through hands-on work over several years.`,
];

/**
 * Drafts (and later revises based on Critic feedback, one piece at a time —
 * see writerCriticLoop.ts's progressive locking). Never critiques its own
 * work — that's the Critic's job, kept as a separate agent per README. Uses
 * the default model: drafting doesn't need the stronger (and pricier) model
 * reserved for the Critic. Set LLM_MODEL_WRITER to point this agent at its
 * own independent model.
 */
export class WriterAgent extends BaseAgent<WriterInput, WriterOutput> {
  readonly name = AgentName.WRITER;
  readonly inputSchema = WriterInputSchema;
  readonly outputSchema = WriterOutputSchema;

  protected async execute(input: WriterInput, ctx: AgentExecutionContext): Promise<WriterOutput> {
    return ctx.tools?.llm ? this.executeWithLlm(input, ctx) : this.executeStub(input);
  }

  private async executeWithLlm(input: WriterInput, ctx: AgentExecutionContext): Promise<WriterOutput> {
    const startedAt = new Date().toISOString();
    const result = await ctx.tools!.llm!.generateStructured({
      consumer: AgentName.WRITER,
      schemaName: "WriterOutput",
      schema: WriterOutputSchema,
      systemPrompt: withPromptAddendum(buildSystemPrompt(input.limits), ctx, this.name),
      userPrompt: JSON.stringify({
        vacancyTitle: input.vacancyTitle,
        companyName: input.companyName,
        candidateResumeText: input.candidateResumeText,
        candidateStrengths: input.strengths,
        vacancyRequirements: input.vacancyRequirements,
        vacancyResponsibilities: input.vacancyResponsibilities,
        priorCriticFeedbackByPieceId: input.priorIssuesByPieceId,
        applicationQuestions: input.applicationQuestions,
        includeCoverLetter: input.includeCoverLetter,
        coverLetterGuidance: input.coverLetterGuidance,
        humanizeStyle: input.humanizeStyle,
        avoidOverfitting: input.avoidOverfitting,
        styleReferenceCoverLetters: input.styleExamples,
        pastAnswerExamples: input.pastAnswerExamples,
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

  private executeStub(input: WriterInput): WriterOutput {
    return {
      coverLetter: input.includeCoverLetter ? this.buildStubCoverLetter(input) : null,
      applicationAnswers: input.applicationQuestions.map((q) => this.buildStubAnswer(input, q)),
    };
  }

  // styleExamples/pastAnswerExamples are deliberately NOT woven into either
  // stub below: they're style-matching inputs a deterministic template bank
  // has no meaningful way to honor.
  private buildStubCoverLetter(input: WriterInput): string {
    const seed = stableHash(`${input.vacancyTitle}|${input.companyName}`);
    const opening = pick(OPENING_BANK, seed)(input.vacancyTitle, input.companyName);
    const strengthSentence =
      input.strengths.length > 0
        ? ` ${pick(STRENGTH_LEAD_BANK, seed + 1)(lowerFirst(joinNaturally(input.strengths)))}.`
        : "";
    const requirementNote = input.vacancyRequirements[0]
      ? ` The posting calls for ${input.vacancyRequirements[0]}, which lines up well with my experience.`
      : "";
    const responsibilityNote = input.vacancyResponsibilities[0]
      ? ` One of the responsibilities mentioned — ${input.vacancyResponsibilities[0]} — is something I've done before.`
      : "";
    const resumeNote = input.candidateResumeText
      ? ` My resume covers this in more detail: ${input.candidateResumeText.slice(0, 60)}...`
      : "";
    const closing = pick(CLOSING_BANK, seed + 2);

    // input.priorIssuesByPieceId is deliberately never woven into this text —
    // a real LLM revises IN RESPONSE to prior feedback, it doesn't narrate
    // "I've revised this to address: <critic's own issue description>" inside
    // the letter itself, which is what an earlier version of this stub did.
    // That's not something a real candidate would ever write, and it's not
    // what the real (non-stub) path produces either — narrating it here made
    // the stub actively less representative of real output, not more.
    return (
      `Dear Hiring Team,\n\n${opening}${strengthSentence}${requirementNote}${responsibilityNote}` +
      `${resumeNote}\n\n${closing}\n\nSincerely,\nCandidate`
    );
  }

  private buildStubAnswer(input: WriterInput, q: WriterQuestion): WriterAnswer {
    const seed = stableHash(q.id);
    const rawStrength =
      input.strengths.length > 0 ? pick(input.strengths, seed) : "the relevant parts of my background";
    const strength = lowerFirst(rawStrength);
    const base = pick(ANSWER_TEMPLATE_BANK, seed)(strength);
    const guidanceNote = q.guidance
      ? ` You asked me to make sure to cover: ${q.guidance} — that's exactly what my experience in ${strength} speaks to.`
      : "";
    // See buildStubCoverLetter's comment above — same reasoning for dropping
    // the "Revised to address: ..." meta-narration.
    return { id: q.id, question: q.question, answer: `${base}${guidanceNote}` };
  }
}
