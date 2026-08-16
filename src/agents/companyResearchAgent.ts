import { z } from "zod";
import { AgentName } from "../types/agent.js";
import { CompanyResearchSchema, SalaryRangeSourceSchema, type SalaryInsight } from "../types/analysis.js";
import { estimateCostUsd } from "../llm/pricing.js";
import type { SearchBroker, SearchResultOutput } from "../tools/searchBroker.js";
import { BaseAgent, withPromptAddendum, type AgentExecutionContext } from "./baseAgent.js";
import { pick, pickPair, stableHash } from "./stubUtils.js";

export const CompanyResearchInputSchema = z.object({
  companyName: z.string().min(1),
  /** Required — used to build every salary-ladder search query below. A placeholder default would produce garbage queries. */
  vacancyTitle: z.string().min(1),
  /** Used for the market-wide salary tier only; omitted queries drop the location qualifier rather than guessing one. */
  location: z.string().optional(),
});
export type CompanyResearchInput = z.infer<typeof CompanyResearchInputSchema>;

export const CompanyResearchOutputSchema = CompanyResearchSchema;
export type CompanyResearchOutput = z.infer<typeof CompanyResearchOutputSchema>;

const SynthesisOutputSchema = z.object({
  positiveSignals: z.array(z.string()),
  risks: z.array(z.string()),
  salaryRange: z.string(),
  salarySource: SalaryRangeSourceSchema,
  salarySourceNote: z.string(),
});

const SYNTHESIS_SYSTEM_PROMPT =
  "You are a company-research analyst. Given a company name and a handful of search result " +
  "titles/snippets about it, extract genuine positive signals and genuine risks — grounded " +
  "ONLY in what the snippets actually say. Snippets are often thin or generic; if they don't " +
  "support a real conclusion, return an empty list or a single honest note like " +
  '"insufficient public data to assess" rather than inventing plausible-sounding signals. State ' +
  "each signal/risk as a short phrase, one key point each — not a paragraph. " +
  "\n\nYou are also given salarySearchResults (snippets from the MOST SPECIFIC search tier that " +
  "actually turned up usable salary data, labeled by salaryTier) or, if every tier came up empty, " +
  "no salary search results at all. If salarySearchResults is non-empty, ground salaryRange in " +
  "those actual snippets and set salarySource to the given salaryTier — never claim a more " +
  "specific tier than what was actually searched. If salarySearchResults is empty, estimate a " +
  "plausible range from your own general knowledge of comparable roles/seniority/location, set " +
  'salarySource to "model_estimate", and say so plainly in salarySourceNote (e.g. "Estimated from ' +
  'general market knowledge — no search data was found"). Only use salarySource "unavailable" ' +
  "(with salaryRange \"Unavailable\") if even a rough estimate isn't reasonable. salarySourceNote " +
  "is always exactly one sentence.";

// Common seniority markers — good enough to pick a search term without a
// dedicated LLM classification call; unmatched titles just skip the
// seniority-at-company tier below.
const SENIORITY_PATTERN = /\b(senior|sr\.?|staff|principal|lead|junior|jr\.?|mid-level|director|vp|head of|chief)\b/i;

/** Exported for direct unit testing. */
export function inferSeniority(vacancyTitle: string): string | undefined {
  const match = vacancyTitle.match(SENIORITY_PATTERN);
  return match ? match[0] : undefined;
}

// Cheap heuristic gate — "does this look like it contains actual comp data,"
// not a quality judgment. Currency symbols, common ISO codes, or "salary"/
// "per year" near a digit.
const SALARY_DATA_PATTERN = /[$€£₽¥]|\b(usd|eur|gbp)\b|\bper year\b|\bannually\b|\bsalary\b[^.]{0,20}\d/i;

/** Exported for direct unit testing. */
export function looksLikeSalaryData(results: SearchResultOutput["results"]): boolean {
  return results.some((r) => SALARY_DATA_PATTERN.test(r.snippet) || SALARY_DATA_PATTERN.test(r.title));
}

interface SalaryLadderResult {
  tier: z.infer<typeof SalaryRangeSourceSchema> | null;
  results: SearchResultOutput["results"];
}

/**
 * Plain code, no LLM — tries progressively broader queries via the same
 * injected SearchBroker CompanyResearchAgent already uses, stopping at the
 * first tier whose results look like real salary data. `SearchBroker`
 * throttles ~1.1s between calls, so a full 3-tier miss adds real latency to
 * `analyze()` — an accepted trade-off for an explicitly-requested feature.
 */
async function runSalaryLadder(
  input: CompanyResearchInput,
  searchBroker: SearchBroker | undefined
): Promise<SalaryLadderResult> {
  if (!searchBroker) return { tier: null, results: [] };

  const seniority = inferSeniority(input.vacancyTitle);
  const queries: { tier: z.infer<typeof SalaryRangeSourceSchema>; query: string }[] = [
    { tier: "role_at_company", query: `${input.vacancyTitle} salary range at ${input.companyName}` },
    ...(seniority
      ? ([{ tier: "seniority_at_company", query: `${seniority} salary range at ${input.companyName}` }] as const)
      : []),
    {
      tier: "market_or_similar_companies",
      query: `${input.vacancyTitle} salary range${input.location ? ` ${input.location}` : ""}`,
    },
  ];

  for (const { tier, query } of queries) {
    const result = await searchBroker.execute({ query }, {});
    if (looksLikeSalaryData(result.results)) return { tier, results: result.results };
  }
  return { tier: null, results: [] };
}

// Stub-only signal banks (never seen by the real LLM path) — grounded with
// the actual company name so a demo response doesn't read as obviously
// interchangeable boilerplate across different companies.
const POSITIVE_SIGNAL_BANK: ((name: string) => string)[] = [
  (name) => `${name} has generally positive reviews from current and former employees.`,
  (name) => `${name} appears to have a stable, established presence in its market.`,
  (name) => `Public sentiment around ${name} leans positive overall.`,
  (name) => `${name} shows up favorably in most publicly available reviews.`,
];
const RISK_BANK: ((name: string) => string)[] = [
  (name) => `Some reviews mention above-average turnover at ${name}.`,
  (name) => `A handful of reports raise concerns about pace of work at ${name}.`,
  (name) => `Recent layoffs have been reported at ${name}.`,
  (name) => `A few reviews flag inconsistent management practices at ${name}.`,
];

/**
 * Illustrates "agents never search independently" — this agent goes through
 * the injected Search Broker tool rather than calling any search API itself.
 * Sources (both culture-research `sources` and salary `sourceUrls`) always
 * come directly from real search results, never from the LLM; only the
 * positiveSignals/risks/salary-narrative assessment is LLM-synthesized, in
 * one call alongside the culture-research signals — one LLM call total.
 */
export class CompanyResearchAgent extends BaseAgent<CompanyResearchInput, CompanyResearchOutput> {
  readonly name = AgentName.COMPANY_RESEARCH;
  readonly inputSchema = CompanyResearchInputSchema;
  readonly outputSchema = CompanyResearchOutputSchema;

  protected async execute(
    input: CompanyResearchInput,
    ctx: AgentExecutionContext
  ): Promise<CompanyResearchOutput> {
    const searchBroker = ctx.tools?.searchBroker;
    const searchResult: SearchResultOutput = searchBroker
      ? await searchBroker.execute({ query: `${input.companyName} reviews culture` }, {})
      : { results: [], cacheHit: false };
    const salaryLadder = await runSalaryLadder(input, searchBroker);

    if (ctx.tools?.llm && (searchResult.results.length > 0 || salaryLadder.tier !== null)) {
      return this.synthesizeWithLlm(input, searchResult, salaryLadder, ctx);
    }

    return this.buildStub(input.companyName, searchResult);
  }

  private async synthesizeWithLlm(
    input: CompanyResearchInput,
    searchResult: SearchResultOutput,
    salaryLadder: SalaryLadderResult,
    ctx: AgentExecutionContext
  ): Promise<CompanyResearchOutput> {
    const startedAt = new Date().toISOString();
    const result = await ctx.tools!.llm!.generateStructured({
      consumer: AgentName.COMPANY_RESEARCH,
      schemaName: "CompanySignalsAndSalary",
      schema: SynthesisOutputSchema,
      systemPrompt: withPromptAddendum(SYNTHESIS_SYSTEM_PROMPT, ctx, this.name),
      userPrompt: JSON.stringify({
        companyName: input.companyName,
        vacancyTitle: input.vacancyTitle,
        location: input.location,
        searchResults: searchResult.results.map((r) => ({ title: r.title, snippet: r.snippet })),
        salaryTier: salaryLadder.tier,
        salarySearchResults: salaryLadder.results.map((r) => ({ title: r.title, snippet: r.snippet })),
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

    const salaryInsight: SalaryInsight = {
      range: result.data.salaryRange,
      source: result.data.salarySource,
      sourceNote: result.data.salarySourceNote,
      // Code-derived, never from the LLM — same "sources always come from
      // real search results" principle the existing `sources` field follows.
      sourceUrls: salaryLadder.tier ? salaryLadder.results.map((r) => r.url) : [],
    };

    return {
      positiveSignals: result.data.positiveSignals,
      risks: result.data.risks,
      sources: searchResult.results.map((r) => r.url),
      salaryInsight,
    };
  }

  private buildStub(companyName: string, searchResult: SearchResultOutput): CompanyResearchOutput {
    const seed = stableHash(companyName);
    const [signalA, signalB] = pickPair(POSITIVE_SIGNAL_BANK, seed);
    return {
      positiveSignals: [signalA(companyName), signalB(companyName)],
      risks: seed % 4 === 0 ? [pick(RISK_BANK, seed)(companyName)] : [],
      sources: searchResult.results.map((r) => r.url),
      salaryInsight: {
        range: "Unavailable",
        source: "unavailable",
        sourceNote:
          "No LLM provider is configured, so the search results above couldn't be synthesized into a real estimate.",
        sourceUrls: [],
      },
    };
  }
}
