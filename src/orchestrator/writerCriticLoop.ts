import type { AgentExecutionContext } from "../agents/baseAgent.js";
import { buildAgentRequest } from "../agents/baseAgent.js";
import type { CriticAgent, CriticInput } from "../agents/criticAgent.js";
import type { WriterAgent, WriterOutput, WriterQuestion } from "../agents/writerAgent.js";
import type { WriterLimits } from "../config/env.js";
import { AgentName } from "../types/agent.js";
import type { ApplicationAnswer, CriticIssue, FinalReview, LockedPieceReview } from "../types/application.js";

export const MAX_WRITER_CRITIC_ITERATIONS = 4;
export const QUALITY_SCORE_THRESHOLD = 75;

/** The cover letter's pieceId — exported so callers (e.g. orchestrator.ts) never hardcode this string separately. */
export const COVER_LETTER_PIECE_ID = "cover_letter";
const MISSING_ANSWER_PLACEHOLDER =
  "Generation did not produce an answer for this question — please write one manually.";

export interface WriterCriticLoopParams {
  runId: string;
  vacancyTitle: string;
  companyName: string;
  strengths: string[];
  /** Full text of the resume Resume Selector chose — the primary grounding source when present. */
  candidateResumeText?: string;
  /** The vacancy's own stated requirements/responsibilities — see NormalizedVacancySchema. */
  vacancyRequirements?: string[];
  vacancyResponsibilities?: string[];
  /** False skips the cover letter entirely — see Orchestrator.generate()'s includeCoverLetter setting. Defaults to true. */
  generateCoverLetter?: boolean;
  /** Free-text note on what the cover letter should make sure to mention — see writerAgent.ts's BODY_INSTRUCTIONS. */
  coverLetterGuidance?: string;
  /** Whole-call setting (not per-piece, unlike guidance) — see writerAgent.ts's BODY_INSTRUCTIONS. Defaults to false. */
  humanizeStyle?: boolean;
  /** Whole-call setting, mirrors humanizeStyle — see writerAgent.ts's BODY_INSTRUCTIONS. Defaults to false. */
  avoidOverfitting?: boolean;
  /** Candidate's own past cover letters, for style/voice reference only — see CoverLetterLibrary. */
  styleExamples?: string[];
  /** Past question->answer pairs, for grounding only — see AnswerExampleLibrary. */
  pastAnswerExamples?: string[];
  /** Union of extracted-and-filtered form fields and manually-entered questions. */
  applicationQuestions?: WriterQuestion[];
  /** Already resolved (per-run override merged with env defaults) — see config/env.ts's resolveWriterLimits(). */
  limits: WriterLimits;
  /** Test-fixture-only: forces the loop to run all 4 iterations without converging. */
  forceNoConvergence?: boolean;
  /** Caps this call's refinement passes — defaults to MAX_WRITER_CRITIC_ITERATIONS when omitted. See Orchestrator's maxWriterCriticIterations setting. */
  maxIterations?: number;
}

export interface WriterCriticLoopResult {
  coverLetter: string;
  applicationAnswers: ApplicationAnswer[];
  finalReview: FinalReview;
  iterationsUsed: number;
}

/** One piece still being written/reviewed — `question` is absent for the (always-present) cover letter piece. */
interface PieceWorkItem {
  id: string;
  label: string;
  question?: WriterQuestion;
}

interface LockedEntry {
  text: string;
  issues: CriticIssue[];
  qualityScore: number;
  iteration: number;
  converged: boolean;
}

function hasCriticalIssues(issues: CriticIssue[]): boolean {
  return issues.some((issue) => issue.severity === "critical");
}

function pieceConverged(review: { issues: CriticIssue[]; qualityScore: number }): boolean {
  return !hasCriticalIssues(review.issues) && review.qualityScore >= QUALITY_SCORE_THRESHOLD;
}

/**
 * Resolves Writer's answer array against the questions actually asked this
 * round. Defends against two distinct LLM shape hiccups: a mislabeled `id`
 * (falls back to positional matching against leftover answers) and an answer
 * missing entirely (that question's id simply has no entry in the returned
 * map — the caller treats that as "no answer yet", never silently ignored).
 */
function resolveWriterAnswers(
  questions: WriterQuestion[],
  answers: WriterOutput["applicationAnswers"]
): Map<string, string> {
  const byId = new Map(answers.map((a) => [a.id, a.answer]));
  const unmatchedAnswers = answers.filter((a) => !questions.some((q) => q.id === a.id));

  const resolved = new Map<string, string>();
  let unmatchedIndex = 0;
  for (const q of questions) {
    const direct = byId.get(q.id);
    if (direct !== undefined) {
      resolved.set(q.id, direct);
    } else if (unmatchedIndex < unmatchedAnswers.length) {
      resolved.set(q.id, unmatchedAnswers[unmatchedIndex]!.answer);
      unmatchedIndex++;
    }
    // else: genuinely missing this round — left unresolved (empty text downstream).
  }
  return resolved;
}

function buildCriticPiece(
  piece: PieceWorkItem,
  text: string,
  limits: WriterLimits,
  coverLetterGuidance: string | undefined
): CriticInput["pieces"][number] {
  if (!piece.question) {
    return {
      id: piece.id,
      label: piece.label,
      text,
      rangeUnit: "words",
      minWords: limits.coverLetterMinWords,
      max: limits.coverLetterMaxWords,
      guidance: coverLetterGuidance,
    };
  }
  if (piece.question.maxCharacters) {
    return {
      id: piece.id,
      label: piece.label,
      text,
      rangeUnit: "characters",
      max: piece.question.maxCharacters,
      guidance: piece.question.guidance,
    };
  }
  // No detected character limit: falls back to the existing ceiling-only
  // "Fallback answer max words" setting — deliberately NOT the cover letter's
  // floor-and-ceiling range, which would wrongly penalize a short, honest
  // answer for being under a 200-word minimum it was never meant to have.
  return {
    id: piece.id,
    label: piece.label,
    text,
    rangeUnit: "words",
    max: limits.answerMaxWords,
    guidance: piece.question.guidance,
  };
}

/**
 * Pure(-ish) — its only side effects are the two injected agents' run() calls
 * and trace events they record via ctx.tracer, which is why this is extracted
 * from orchestrator.ts as an independently testable unit.
 *
 * Progressive locking: instead of regenerating every piece every iteration
 * until they all happen to pass simultaneously, each piece that converges is
 * locked (kept verbatim) and dropped from the working set — later iterations
 * only re-write/re-review pieces still failing the bar. This avoids wasting
 * calls against the pricier Critic model on content that already passed, and
 * avoids the regression risk of an LLM "fixing" something that wasn't broken.
 * The hard cap is folded into the same loop body: whatever's left on the
 * final allowed iteration is force-locked as-is (`converged: false`) rather
 * than looping again — MAX_WRITER_CRITIC_ITERATIONS is an unconditional
 * ceiling covering the whole call, not per piece.
 *
 * With exactly one piece (no detected/manual questions — cover letter only),
 * this degenerates to exactly today's original loop.
 */
export async function runWriterCriticLoop(
  params: WriterCriticLoopParams,
  agents: { writer: WriterAgent; critic: CriticAgent },
  ctx: AgentExecutionContext
): Promise<WriterCriticLoopResult> {
  const questions = params.applicationQuestions ?? [];
  let piecesToWrite: PieceWorkItem[] = [
    ...(params.generateCoverLetter !== false ? [{ id: COVER_LETTER_PIECE_ID, label: "Cover Letter" }] : []),
    ...questions.map((q) => ({ id: q.id, label: q.question, question: q })),
  ];
  const locked = new Map<string, LockedEntry>();
  // Persists across iterations (unlike a per-iteration local) so a piece that
  // locked earlier keeps its text available for Critic's payload right up
  // until it's actually removed from piecesToWrite — Writer is never asked to
  // regenerate it (see includeCoverLetter below).
  const pieceTexts = new Map<string, string>();
  let priorIssuesByPieceId: Record<string, string[]> = {};
  let finalIteration = 0;
  const maxIterations = params.maxIterations ?? MAX_WRITER_CRITIC_ITERATIONS;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (piecesToWrite.length === 0) break;
    finalIteration = iteration;
    const isLastIteration = iteration === maxIterations;
    const includeCoverLetter = piecesToWrite.some((p) => p.id === COVER_LETTER_PIECE_ID);
    const activeQuestions = piecesToWrite
      .map((p) => p.question)
      .filter((q): q is WriterQuestion => Boolean(q));

    const writerRequest = buildAgentRequest(
      params.runId,
      AgentName.WRITER,
      {
        vacancyTitle: params.vacancyTitle,
        companyName: params.companyName,
        strengths: params.strengths,
        priorIssuesByPieceId,
        styleExamples: params.styleExamples ?? [],
        pastAnswerExamples: params.pastAnswerExamples ?? [],
        candidateResumeText: params.candidateResumeText,
        vacancyRequirements: params.vacancyRequirements ?? [],
        vacancyResponsibilities: params.vacancyResponsibilities ?? [],
        applicationQuestions: activeQuestions,
        includeCoverLetter,
        coverLetterGuidance: includeCoverLetter ? params.coverLetterGuidance : undefined,
        humanizeStyle: params.humanizeStyle ?? false,
        avoidOverfitting: params.avoidOverfitting ?? false,
        limits: params.limits,
      },
      { iteration }
    );
    const writerResponse = await agents.writer.run(writerRequest, ctx);
    if (writerResponse.status === "error") {
      throw new Error(`Writer failed at iteration ${iteration}: ${writerResponse.error.message}`);
    }

    const resolvedAnswers = resolveWriterAnswers(activeQuestions, writerResponse.output.applicationAnswers);
    if (includeCoverLetter) pieceTexts.set(COVER_LETTER_PIECE_ID, writerResponse.output.coverLetter ?? "");
    // Carries forward the previous round's text if this round didn't produce
    // a new one (a missing-answer hiccup shouldn't regress an already-real,
    // just-not-yet-converged answer back to empty).
    for (const q of activeQuestions) {
      pieceTexts.set(q.id, resolvedAnswers.get(q.id) ?? pieceTexts.get(q.id) ?? "");
    }

    const criticRequest = buildAgentRequest(
      params.runId,
      AgentName.CRITIC,
      {
        pieces: piecesToWrite.map((p) =>
          buildCriticPiece(p, pieceTexts.get(p.id) ?? "", params.limits, params.coverLetterGuidance)
        ),
        iteration,
        vacancyRequirements: params.vacancyRequirements ?? [],
        vacancyResponsibilities: params.vacancyResponsibilities ?? [],
        humanizeStyle: params.humanizeStyle ?? false,
        avoidOverfitting: params.avoidOverfitting ?? false,
        forceNoConvergence: params.forceNoConvergence ?? false,
      },
      { iteration, previousResponseId: writerResponse.responseId }
    );
    const criticResponse = await agents.critic.run(criticRequest, ctx);
    if (criticResponse.status === "error") {
      throw new Error(`Critic failed at iteration ${iteration}: ${criticResponse.error.message}`);
    }

    const reviewByPieceId = new Map(criticResponse.output.pieceReviews.map((r) => [r.pieceId, r]));
    const nextPiecesToWrite: PieceWorkItem[] = [];
    const nextPriorIssues: Record<string, string[]> = {};

    for (const piece of piecesToWrite) {
      const text = pieceTexts.get(piece.id) ?? "";
      const review = reviewByPieceId.get(piece.id);

      // Round-6 safety net: Critic's response omitted this piece entirely (a
      // realistic structured-output shape hiccup, distinct from a mislabeled
      // id) — never let it silently vanish from the final package.
      if (!review) {
        if (isLastIteration) {
          locked.set(piece.id, {
            text: text || MISSING_ANSWER_PLACEHOLDER,
            issues: [
              { severity: "major", description: "No review was returned for this piece — content is unverified." },
            ],
            qualityScore: 0,
            iteration,
            converged: false,
          });
        } else {
          nextPiecesToWrite.push(piece);
          nextPriorIssues[piece.id] = ["No response was returned for this piece last round — please try again."];
        }
        continue;
      }

      const converged = pieceConverged(review);
      if (converged || isLastIteration) {
        locked.set(piece.id, {
          text: text || MISSING_ANSWER_PLACEHOLDER,
          issues: review.issues,
          qualityScore: review.qualityScore,
          iteration,
          converged,
        });
      } else {
        nextPiecesToWrite.push(piece);
        nextPriorIssues[piece.id] = review.issues.map((i) => i.description);
      }
    }

    piecesToWrite = nextPiecesToWrite;
    priorIssuesByPieceId = nextPriorIssues;
  }

  const coverLetterLocked = locked.get(COVER_LETTER_PIECE_ID);
  if (!coverLetterLocked && params.generateCoverLetter !== false) {
    throw new Error("Writer/Critic loop exited without locking the cover letter piece");
  }

  const applicationAnswers: ApplicationAnswer[] = questions.flatMap((q) => {
    const lockedPiece = locked.get(q.id);
    return lockedPiece
      ? [{ id: q.id, question: q.question, answer: lockedPiece.text, maxCharacters: q.maxCharacters }]
      : [];
  });

  const pieceReviews: LockedPieceReview[] = [COVER_LETTER_PIECE_ID, ...questions.map((q) => q.id)].flatMap(
    (id) => {
      const entry = locked.get(id);
      return entry
        ? [{ pieceId: id, issues: entry.issues, qualityScore: entry.qualityScore, iteration: entry.iteration, converged: entry.converged }]
        : [];
    }
  );

  return {
    coverLetter: coverLetterLocked?.text ?? "",
    applicationAnswers,
    finalReview: { pieceReviews, converged: pieceReviews.every((r) => r.converged) },
    iterationsUsed: finalIteration,
  };
}
