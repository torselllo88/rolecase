import { z } from "zod";
import { NormalizedVacancySchema } from "./vacancy.js";

export const RecommendationSchema = z.enum(["APPLY", "APPLY_WITH_CAUTION", "REJECT"]);
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const AtsKeywordCoverageSchema = z.object({
  keyword: z.string(),
  covered: z.boolean(),
});
export type AtsKeywordCoverage = z.infer<typeof AtsKeywordCoverageSchema>;

export const FitAnalysisSchema = z.object({
  // No .min()/.max() on purpose — this is VacancyAnalyzerAgent's real
  // structured-output schema, and at least one provider (Claude via
  // OpenRouter/Azure) rejects "minimum"/"maximum" on a JSON Schema "number"
  // type outright ("output_config.format.schema: For 'number' type,
  // properties maximum, minimum are not supported"). The 0-100 range is
  // enforced by prompt instruction only; every consumer (decideRecommendation
  // etc.) already handles an out-of-range value gracefully via comparison,
  // so nothing downstream actually needs the schema-level constraint.
  fitScore: z.number(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  missingSkills: z.array(z.string()),
  atsKeywordCoverage: z.array(AtsKeywordCoverageSchema),
  strategicRecommendation: z.string(),
  /**
   * Lightweight pointer/heuristic only ("which resume looks like the best fit,
   * at a glance"). README's Phase 1 output list and the Phase 2 Resume Selector
   * both mention "suggested resume" at two different levels of depth; the actual
   * selection + concrete edits live in ResumeSelection (application.ts).
   */
  suggestedResumeHint: z.string(),
});
export type FitAnalysis = z.infer<typeof FitAnalysisSchema>;

/**
 * Which tier of the salary-research fallback ladder actually produced the
 * answer (see companyResearchAgent.ts's runSalaryLadder) — always surfaced
 * to the user so a real-listing figure is never confused with a rough
 * model estimate.
 */
export const SalaryRangeSourceSchema = z.enum([
  "role_at_company",
  "seniority_at_company",
  "market_or_similar_companies",
  "model_estimate",
  "unavailable",
]);
export type SalaryRangeSource = z.infer<typeof SalaryRangeSourceSchema>;

export const SalaryInsightSchema = z.object({
  range: z.string(),
  source: SalaryRangeSourceSchema,
  sourceNote: z.string(),
  sourceUrls: z.array(z.string()),
});
export type SalaryInsight = z.infer<typeof SalaryInsightSchema>;

export const CompanyResearchSchema = z.object({
  positiveSignals: z.array(z.string()),
  risks: z.array(z.string()),
  sources: z.array(z.string()),
  /** Informational only — never factored into fitScore/recommendation. */
  salaryInsight: SalaryInsightSchema,
});
export type CompanyResearch = z.infer<typeof CompanyResearchSchema>;

/** Matches README's literal "Vacancy Report" output artifact. */
export const VacancyReportSchema = z.object({
  vacancy: NormalizedVacancySchema,
  summary: z.string(),
  fitAnalysis: FitAnalysisSchema,
  companyResearch: CompanyResearchSchema,
  recommendation: RecommendationSchema,
  finalRecommendationNotes: z.string(),
});
export type VacancyReport = z.infer<typeof VacancyReportSchema>;
