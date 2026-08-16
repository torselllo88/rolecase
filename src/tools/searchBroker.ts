import { z } from "zod";
import type { Tool, ToolExecutionContext } from "../types/tool.js";
import { stableHash } from "../agents/stubUtils.js";
import { env } from "../config/env.js";

export const SearchQueryInputSchema = z.object({ query: z.string().min(1) });
export type SearchQueryInput = z.infer<typeof SearchQueryInputSchema>;

export const SearchResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
});

export const SearchResultOutputSchema = z.object({
  results: z.array(SearchResultSchema),
  cacheHit: z.boolean(),
});
export type SearchResultOutput = z.infer<typeof SearchResultOutputSchema>;

interface BraveWebSearchResponse {
  web?: {
    results?: Array<{ url: string; title: string; description?: string }>;
  };
}

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/**
 * Centralizes external search per README's Search Broker responsibility:
 * agents never search directly. Real cache/dedup/rate-limit logic. Calls the
 * real Brave Search API when BRAVE_SEARCH_API_KEY is configured (see
 * config/env.ts); falls back to a deterministic stub otherwise, so tests and
 * key-less local dev never touch the network.
 */
export class SearchBroker implements Tool<SearchQueryInput, SearchResultOutput> {
  readonly name = "search_broker.query";
  readonly description =
    "Runs a centralized, cached, rate-limited search query and returns normalized results.";
  readonly inputSchema = SearchQueryInputSchema;
  readonly outputSchema = SearchResultOutputSchema;

  private readonly cache = new Map<string, SearchResultOutput>();
  private lastCallAt = 0;
  private readonly minIntervalMs: number;
  /** Not readonly — the admin Settings page can change this key at runtime; see setApiKey(). */
  private apiKey: string | undefined;

  /**
   * `apiKey` defaults to env.braveSearchApiKey but is a real constructor
   * param (not read from env inline in execute()) specifically so tests can
   * inject a fake key and mock `fetch` to exercise the real-search branch
   * without touching the network or the process-wide env singleton.
   */
  constructor(minIntervalMs = 1100, apiKey: string | undefined = env.braveSearchApiKey) {
    this.minIntervalMs = minIntervalMs;
    this.apiKey = apiKey;
  }

  /**
   * Rebuilds the effective key from app_settings/.env — called right after
   * the admin Settings page saves a key change, so it takes effect on this
   * already-running process without a restart (mirrors Orchestrator's
   * refreshLlmProvider()). Deliberately mutates in place rather than
   * constructing a new SearchBroker, so the result cache/rate-limit
   * throttle state above survives a settings save.
   */
  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
  }

  async execute(input: SearchQueryInput, _ctx: ToolExecutionContext): Promise<SearchResultOutput> {
    const normalizedQuery = input.query.trim().toLowerCase();

    const cached = this.cache.get(normalizedQuery);
    if (cached) {
      return { ...cached, cacheHit: true };
    }

    await this.throttle();

    const result = this.apiKey
      ? await this.queryBraveSearch(normalizedQuery)
      : this.buildStubResult(normalizedQuery, input.query);

    this.cache.set(normalizedQuery, result);
    return result;
  }

  private async queryBraveSearch(query: string): Promise<SearchResultOutput> {
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", "5");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey as string,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Brave Search request failed: ${response.status} ${response.statusText} (query: "${query}")`
      );
    }

    const data = (await response.json()) as BraveWebSearchResponse;
    return {
      results: (data.web?.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.description ?? "",
      })),
      cacheHit: false,
    };
  }

  private buildStubResult(normalizedQuery: string, originalQuery: string): SearchResultOutput {
    const seed = stableHash(normalizedQuery);
    return {
      results: [
        {
          url: `https://example.com/search?q=${encodeURIComponent(normalizedQuery)}&r=1`,
          title: `Stub result 1 for "${originalQuery}"`,
          snippet: `Deterministic mock snippet (${seed % 1000}) — no BRAVE_SEARCH_API_KEY configured.`,
        },
        {
          url: `https://example.com/search?q=${encodeURIComponent(normalizedQuery)}&r=2`,
          title: `Stub result 2 for "${originalQuery}"`,
          snippet: "Deterministic mock snippet — set BRAVE_SEARCH_API_KEY in .env for real results.",
        },
      ],
      cacheHit: false,
    };
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.minIntervalMs - (now - this.lastCallAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastCallAt = Date.now();
  }
}
