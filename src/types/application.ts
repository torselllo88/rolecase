import { z } from "zod";

export const ResumeSelectionSchema = z.object({
  selectedResumeId: z.string(),
  suggestedModifications: z.array(z.string()),
  reasoning: z.string(),
});
export type ResumeSelection = z.infer<typeof ResumeSelectionSchema>;

/**
 * Shared "one reviewable piece of writing" shape — the cover letter and every
 * dynamic application answer are each a piece. Defined once here and reused by
 * Critic and Evidence Checker rather than redefined per-agent.
 */
export const PieceInputSchema = z.object({
  id: z.string(),
  label: z.string(),
  text: z.string(),
});
export type PieceInput = z.infer<typeof PieceInputSchema>;

export const EvidenceEntrySchema = z.object({
  claim: z.string(),
  evidence: z.array(z.string()),
  supported: z.boolean(),
});
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

export const EvidencePieceResultSchema = z.object({
  pieceId: z.string(),
  entries: z.array(EvidenceEntrySchema),
  unsupportedClaims: z.array(z.string()),
});
export type EvidencePieceResult = z.infer<typeof EvidencePieceResultSchema>;

export const EvidenceMapSchema = z.object({
  pieceResults: z.array(EvidencePieceResultSchema),
});
export type EvidenceMap = z.infer<typeof EvidenceMapSchema>;

export const CriticIssueSchema = z.object({
  severity: z.enum(["critical", "major", "minor"]),
  description: z.string(),
});
export type CriticIssue = z.infer<typeof CriticIssueSchema>;

/** A piece to review, plus which unit (words vs. characters) its limit is expressed in. */
export const CriticPieceInputSchema = PieceInputSchema.extend({
  rangeUnit: z.enum(["words", "characters"]),
  /** Only meaningful for rangeUnit "words" — a character ceiling has no separate floor concept. */
  minWords: z.number().int().positive().optional(),
  max: z.number().int().positive(),
  /** The candidate's own note on what this piece should make sure to mention — see writerAgent.ts's BODY_INSTRUCTIONS. */
  guidance: z.string().optional(),
});
export type CriticPieceInput = z.infer<typeof CriticPieceInputSchema>;

export const CriticPieceReviewSchema = z.object({
  pieceId: z.string(),
  issues: z.array(CriticIssueSchema),
  // No .min()/.max() on purpose — this is part of CriticAgent's real
  // structured-output schema, and at least one provider (Claude via
  // OpenRouter/Azure) rejects "minimum"/"maximum" on a JSON Schema "number"
  // type outright. The 0-100 range is enforced by prompt instruction only;
  // pieceConverged()'s `>= QUALITY_SCORE_THRESHOLD` comparison already
  // handles an out-of-range value gracefully, so nothing downstream actually
  // needs the schema-level constraint.
  qualityScore: z.number(),
});
export type CriticPieceReview = z.infer<typeof CriticPieceReviewSchema>;

/**
 * The persisted, loop-level shape — adds `iteration`/`converged`, which the
 * Critic agent itself has no notion of (that's the writer/critic loop's
 * "progressive locking" bookkeeping layered on top, see writerCriticLoop.ts).
 */
export const LockedPieceReviewSchema = CriticPieceReviewSchema.extend({
  iteration: z.number().int().min(1).max(4),
  converged: z.boolean(),
});
export type LockedPieceReview = z.infer<typeof LockedPieceReviewSchema>;

export const FinalReviewSchema = z.object({
  pieceReviews: z.array(LockedPieceReviewSchema),
  converged: z.boolean(),
});
export type FinalReview = z.infer<typeof FinalReviewSchema>;

export const ApplicationAnswerSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  maxCharacters: z.number().int().positive().optional(),
});
export type ApplicationAnswer = z.infer<typeof ApplicationAnswerSchema>;

/** Matches README's literal "Application Package" output artifact. */
export const ApplicationPackageSchema = z.object({
  resumeSelection: ResumeSelectionSchema,
  coverLetter: z.string(),
  applicationAnswers: z.array(ApplicationAnswerSchema),
  recruiterNotes: z.string().optional(),
  evidenceMap: EvidenceMapSchema,
  /** The Critic's last verdict per piece when the writer/critic loop ends — README's Phase 2 "final review". */
  finalReview: FinalReviewSchema,
  iterationsUsed: z.number().int().min(1).max(4),
});
export type ApplicationPackage = z.infer<typeof ApplicationPackageSchema>;
