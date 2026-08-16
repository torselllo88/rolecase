import { z } from "zod";

export const ManualQuestionSchema = z.object({
  // Client-assigned (crypto.randomUUID() in app.js) at row-creation time — not
  // derived from the question text, so editing a typo doesn't orphan its
  // identity/history across regenerate attempts.
  id: z.string(),
  question: z.string(),
  maxCharacters: z.number().int().positive().optional(),
  /** Free-text note on what to make sure this answer covers — see writerAgent.ts's BODY_INSTRUCTIONS. */
  guidance: z.string().optional(),
});
export type ManualQuestion = z.infer<typeof ManualQuestionSchema>;

export const GenerationSettingsSchema = z.object({
  limits: z.object({
    coverLetterMinWords: z.number().int().positive(),
    coverLetterMaxWords: z.number().int().positive(),
    answerMaxWords: z.number().int().positive(),
  }),
  manualQuestions: z.array(ManualQuestionSchema),
  includeCoverLetter: z.boolean().default(true),
  /**
   * Guidance notes keyed by field id, for detected fields (which have no
   * other persisted object to carry a note on — form-fields.json gets
   * overwritten on every re-detect) and the cover letter (keyed by
   * COVER_LETTER_PIECE_ID, "cover_letter" — see writerCriticLoop.ts). Manual
   * questions carry their own `guidance` directly instead (see
   * ManualQuestionSchema above), since they're already persisted objects.
   *
   * `.default()` only fires through an actual zod `.parse()` call — fileStore
   * reads are a raw `JSON.parse(...) as Type` cast, so callers reading an old
   * settings file written before this field existed must still apply their
   * own `?? {}` fallback (same reasoning applies to `includeCoverLetter` above).
   */
  guidanceById: z.record(z.string(), z.string()).default({}),
  /** See writerAgent.ts's BODY_INSTRUCTIONS — tells Writer/Critic to actively avoid common AI-writing tells. */
  humanizeStyle: z.boolean().default(false),
  /** See writerAgent.ts's BODY_INSTRUCTIONS — tells Writer/Critic not to over-mirror the vacancy's own wording/buzzwords. */
  avoidOverfitting: z.boolean().default(false),
});
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;
