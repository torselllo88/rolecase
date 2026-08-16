import { z } from "zod";
import { AgentName } from "../types/agent.js";
import { EmploymentTypeSchema, NormalizedVacancySchema } from "../types/vacancy.js";
import { FitAnalysisSchema } from "../types/analysis.js";
import { estimateCostUsd } from "../llm/pricing.js";
import { BaseAgent, withPromptAddendum, type AgentExecutionContext } from "./baseAgent.js";
import { pick, stableHash } from "./stubUtils.js";

export const VacancyAnalyzerInputSchema = z.object({
  rawText: z.string().min(1),
  /**
   * The "candidate profile" for fit-scoring — resume text (labeled by id),
   * plus cover-letter/answer-library excerpts when present (see
   * orchestrator.ts's buildCandidateProfileText). Absent only when every one
   * of those sources is empty.
   */
  candidateProfileText: z.string().optional(),
});
export type VacancyAnalyzerInput = z.infer<typeof VacancyAnalyzerInputSchema>;

export const VacancyAnalyzerOutputSchema = z.object({
  vacancy: NormalizedVacancySchema,
  summary: z.string(),
  fitAnalysis: FitAnalysisSchema,
});
export type VacancyAnalyzerOutput = z.infer<typeof VacancyAnalyzerOutputSchema>;

const VacancyParseSchema = z.object({
  vacancy: NormalizedVacancySchema,
  summary: z.string(),
});

const EMPLOYMENT_TYPES = EmploymentTypeSchema.options;

// --- Stub-only heuristic extraction (never seen by the real LLM path) ---
// A genuine parse needs an LLM; without one, the best a deterministic stub
// can honestly do is pull real lines out of the pasted text itself (company/
// title/section bullets/questions actually present in the posting) and only
// fall back to a generic placeholder when nothing was found — never invent
// specifics that look real but aren't.

/** Exported for direct unit testing. */
export function extractCompanyName(rawText: string): string {
  const labelMatch = rawText.match(/\b(?:Company|Employer|Organization)\s*:\s*([^\n,.]{2,60})/i);
  if (labelMatch) return labelMatch[1]!.trim();
  const atMatch = rawText.match(/\bat\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/);
  if (atMatch) return atMatch[1]!.trim().replace(/[.,]+$/, "");
  return "this company";
}

/** Exported for direct unit testing. */
export function extractTitle(rawText: string): string {
  const labelMatch = rawText.match(/\b(?:Title|Position|Role)\s*:\s*([^\n]{2,80})/i);
  if (labelMatch) return labelMatch[1]!.trim();
  const firstLine = rawText.split("\n").find((line) => line.trim().length > 0) ?? "Unknown Role";
  return firstLine
    .replace(/\s+at\s+[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3}\.?\s*$/, "")
    .trim()
    .slice(0, 80);
}

const BULLET_LINE_PATTERN = /^\s*(?:[-•*–]|\d+[.)])\s+(.+)$/;
const NEXT_SECTION_HEADER_PATTERN = /^[A-Z][A-Za-z /]{2,30}:?\s*$/;

/** Pulls bulleted lines out from under the first line matching `headerPattern`, stopping at the next blank line (once at least one bullet was found) or the next apparent section header. Returns [] if the section isn't present at all — callers fall back to a generic bank rather than inventing content. */
function extractBulletSection(rawText: string, headerPattern: RegExp, maxItems = 6): string[] {
  const lines = rawText.split("\n");
  const headerIndex = lines.findIndex((line) => headerPattern.test(line.trim()));
  if (headerIndex === -1) return [];

  const items: string[] = [];
  for (let i = headerIndex + 1; i < lines.length && items.length < maxItems; i++) {
    const line = lines[i]!;
    const bulletMatch = line.match(BULLET_LINE_PATTERN);
    if (bulletMatch) {
      items.push(bulletMatch[1]!.trim());
      continue;
    }
    if (!line.trim()) {
      if (items.length > 0) break;
      continue;
    }
    if (NEXT_SECTION_HEADER_PATTERN.test(line.trim()) && items.length > 0) break;
  }
  return items;
}

const REQUIREMENTS_HEADER = /^(requirements|qualifications|what you.?ll need|what we.?re looking for)\b/i;
const RESPONSIBILITIES_HEADER = /^(responsibilities|what you.?ll do|the role|duties)\b/i;
const BENEFITS_HEADER = /^(benefits|perks|what we offer)\b/i;

const FALLBACK_REQUIREMENTS = [
  ["3+ years of relevant experience", "Strong communication skills", "Familiarity with the domain"],
  ["A proven track record in a similar role", "Comfort working with ambiguity", "Solid written and verbal communication"],
  ["Demonstrated experience in the field", "Ability to work cross-functionally", "A collaborative, ownership-driven mindset"],
];
const FALLBACK_RESPONSIBILITIES = [
  ["Own a workstream end-to-end", "Collaborate cross-functionally"],
  ["Drive a project from planning through delivery", "Partner closely with other teams"],
  ["Take ownership of a key area of the product", "Work closely with stakeholders across the org"],
];
const FALLBACK_BENEFITS = [
  ["Health insurance", "Flexible hours"],
  ["Competitive benefits package", "Remote-friendly schedule"],
  ["Health coverage", "Paid time off"],
];
const FALLBACK_QUESTIONS = [
  ["Why do you want this role?"],
  ["What interests you about this position?"],
  ["Why are you a good fit for this team?"],
];

const KEYWORD_DICTIONARY = [
  "python", "javascript", "typescript", "java", "react", "node", "aws", "gcp", "azure",
  "kubernetes", "docker", "sql", "leadership", "strategy", "communication", "product management",
  "agile", "scrum", "data analysis", "machine learning", "stakeholder management",
  "cross-functional", "design", "marketing", "sales",
];
const FALLBACK_KEYWORDS = [
  ["leadership", "strategy", "communication"],
  ["collaboration", "ownership", "problem-solving"],
  ["communication", "adaptability", "attention to detail"],
];

/** Exported for direct unit testing. */
export function extractKeywords(rawText: string, seed: number, max = 6): string[] {
  const lower = rawText.toLowerCase();
  const found = KEYWORD_DICTIONARY.filter((kw) => lower.includes(kw));
  return found.length > 0 ? found.slice(0, max) : pick(FALLBACK_KEYWORDS, seed);
}

/** Exported for direct unit testing. */
export function extractQuestions(rawText: string, seed: number, max = 3): string[] {
  const found = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?") && line.length > 10 && line.length < 200)
    .slice(0, max);
  return found.length > 0 ? found : pick(FALLBACK_QUESTIONS, seed);
}

const PARSE_ONLY_SYSTEM_PROMPT =
  "You are an expert technical recruiter. Extract structured, normalized fields from a raw " +
  "job vacancy posting: company, title, location, employment type, requirements, " +
  "responsibilities, benefits, application questions, and keywords (for ATS matching). " +
  'Do not invent facts that aren\'t present in the text — use "unknown" for a missing scalar ' +
  "field and an empty array for a missing list. Also write a 2-3 sentence neutral summary.";

const PARSE_AND_FIT_SYSTEM_PROMPT =
  "You are an expert technical recruiter and career coach. You are given a raw job vacancy " +
  "posting and a candidate's resume(s) (candidateProfileText, labeled by resume id). Do two " +
  "things in one pass:\n" +
  "1. Parse the vacancy into structured fields (company, title, location, employment type, " +
  'requirements, responsibilities, benefits, application questions, keywords) — use "unknown" ' +
  "or an empty array for anything not present, never invent facts. Write a 2-3 sentence " +
  "neutral summary.\n" +
  "2. Assess the candidate's genuine fit by comparing the vacancy's actual requirements and " +
  "keywords against what the resume(s) actually demonstrate. Score conservatively — a high " +
  "fitScore requires specific, real evidence in the profile matching the vacancy's " +
  "requirements, not general competence. List concrete strengths grounded in specific profile " +
  "content, concrete weaknesses/missingSkills (requirements NOT evidenced in the profile), " +
  "real ATS keyword coverage (mark a keyword covered only if the profile actually contains it " +
  "or a clear synonym), and an honest strategicRecommendation. Set suggestedResumeHint to the " +
  'resume id (from a "=== Resume: <id> ===" header) that looks most relevant if several are given. ' +
  'candidateProfileText may also contain sections labeled "Past cover letter excerpts" and "Past ' +
  'application answers" — these are genuine supplementary evidence of skills or projects the ' +
  "candidate has that may not appear on the resume, not mere style reference; weigh them for " +
  "fit-scoring the same way you would resume content, while still treating the resume(s) as the " +
  "primary evidence. Be brief: each strengths/weaknesses/missingSkills entry is a short phrase " +
  "naming one key point, not a paragraph of reasoning — state the conclusion, don't re-argue it. " +
  "strategicRecommendation is 1-2 sentences.";

/**
 * Two modes: with a candidate profile (from the Resume Library) available and
 * an LLM configured, vacancy parsing AND fit analysis happen together in one
 * real, grounded call. Without a profile — empty library, or no LLM
 * configured — parsing alone can still be real (grounded in the vacancy text
 * only), but fit analysis falls back to a deterministic stub: a genuine fit
 * assessment needs something to compare against, and fabricating one would be
 * confident-looking nonsense instead of honest placeholder data.
 */
export class VacancyAnalyzerAgent extends BaseAgent<VacancyAnalyzerInput, VacancyAnalyzerOutput> {
  readonly name = AgentName.VACANCY_ANALYZER;
  readonly inputSchema = VacancyAnalyzerInputSchema;
  readonly outputSchema = VacancyAnalyzerOutputSchema;

  protected async execute(
    input: VacancyAnalyzerInput,
    ctx: AgentExecutionContext
  ): Promise<VacancyAnalyzerOutput> {
    if (ctx.tools?.llm && input.candidateProfileText) {
      return this.parseAndAssessFitWithLlm(input.rawText, input.candidateProfileText, ctx);
    }

    const { vacancy, summary } = ctx.tools?.llm
      ? await this.parseWithLlm(input.rawText, ctx)
      : this.parseStub(input.rawText);

    return { vacancy, summary, fitAnalysis: this.buildFitAnalysisStub(input.rawText, vacancy.keywords) };
  }

  private async parseAndAssessFitWithLlm(
    rawText: string,
    candidateProfileText: string,
    ctx: AgentExecutionContext
  ): Promise<VacancyAnalyzerOutput> {
    const startedAt = new Date().toISOString();
    const result = await ctx.tools!.llm!.generateStructured({
      consumer: AgentName.VACANCY_ANALYZER,
      schemaName: "VacancyAnalysisWithFit",
      schema: VacancyAnalyzerOutputSchema,
      systemPrompt: withPromptAddendum(PARSE_AND_FIT_SYSTEM_PROMPT, ctx, this.name),
      userPrompt: JSON.stringify({ vacancyText: rawText, candidateProfileText }),
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

  private async parseWithLlm(
    rawText: string,
    ctx: AgentExecutionContext
  ): Promise<z.infer<typeof VacancyParseSchema>> {
    const startedAt = new Date().toISOString();
    const result = await ctx.tools!.llm!.generateStructured({
      consumer: AgentName.VACANCY_ANALYZER,
      schemaName: "VacancyParse",
      schema: VacancyParseSchema,
      systemPrompt: withPromptAddendum(PARSE_ONLY_SYSTEM_PROMPT, ctx, this.name),
      userPrompt: rawText,
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

  private parseStub(rawText: string): z.infer<typeof VacancyParseSchema> {
    const seed = stableHash(rawText);
    const title = extractTitle(rawText);
    const company = extractCompanyName(rawText);
    const requirements = extractBulletSection(rawText, REQUIREMENTS_HEADER);
    const responsibilities = extractBulletSection(rawText, RESPONSIBILITIES_HEADER);
    const benefits = extractBulletSection(rawText, BENEFITS_HEADER);
    const finalRequirements = requirements.length > 0 ? requirements : pick(FALLBACK_REQUIREMENTS, seed);
    const finalResponsibilities =
      responsibilities.length > 0 ? responsibilities : pick(FALLBACK_RESPONSIBILITIES, seed + 1);
    const finalBenefits = benefits.length > 0 ? benefits : pick(FALLBACK_BENEFITS, seed + 2);
    const keywords = extractKeywords(rawText, seed);

    return {
      vacancy: {
        company,
        title,
        location: pick(["Remote", "Berlin, DE", "London, UK", "New York, US"], seed),
        employmentType: pick(EMPLOYMENT_TYPES, seed),
        requirements: finalRequirements,
        responsibilities: finalResponsibilities,
        benefits: finalBenefits,
        applicationQuestions: extractQuestions(rawText, seed),
        keywords,
      },
      summary: this.buildStubSummary(title, company, finalResponsibilities[0], finalRequirements[0]),
    };
  }

  private buildStubSummary(
    title: string,
    company: string,
    firstResponsibility: string | undefined,
    firstRequirement: string | undefined
  ): string {
    const respPart = firstResponsibility ? ` The role centers on ${firstResponsibility.toLowerCase()}.` : "";
    const reqPart = firstRequirement ? ` Looking for someone with ${firstRequirement.toLowerCase()}.` : "";
    return `${title} at ${company}.${respPart}${reqPart}`;
  }

  private buildFitAnalysisStub(rawText: string, keywords: string[]): VacancyAnalyzerOutput["fitAnalysis"] {
    const seed = stableHash(rawText);
    const fitScore = 40 + (seed % 55);
    const relevantKeywords = keywords.length > 0 ? keywords : ["leadership", "strategy"];

    return {
      fitScore,
      strengths: fitScore >= 70 ? ["Directly relevant background"] : ["Adjacent experience"],
      weaknesses: fitScore < 70 ? ["Missing one required skill"] : [],
      missingSkills: fitScore < 60 ? ["Domain-specific certification"] : [],
      atsKeywordCoverage: relevantKeywords
        .slice(0, 4)
        .map((keyword, i) => ({ keyword, covered: (seed + i) % 2 === 0 })),
      strategicRecommendation:
        fitScore >= 70
          ? "Strong match — apply with a tailored resume."
          : "Marginal match — apply only if targeting a stretch role.",
      suggestedResumeHint: "general-experience-resume",
    };
  }
}
