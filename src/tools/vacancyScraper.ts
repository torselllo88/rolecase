import * as cheerio from "cheerio";
import { z } from "zod";
import type { Tool, ToolExecutionContext } from "../types/tool.js";

const ExtractContentInputSchema = z.object({ url: z.string().url() });
const ExtractContentOutputSchema = z.object({ rawText: z.string() });

const FETCH_TIMEOUT_MS = 10_000;
const MAX_EXTRACTED_CHARS = 20_000;
// A generic desktop-browser UA reduces the odds of a trivial UA-sniffing bot
// block; this does no other anti-detection work (no cookies/JS execution) —
// sites requiring a real browser session still fail, same as before.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Stripped before extracting text — none of these ever contain the vacancy
// description itself, and script/style content would otherwise pollute rawText.
const NOISE_SELECTORS = "script, style, nav, header, footer, noscript, svg";

/**
 * Fetch-based replacement for the old Playwright `browser.extract_content`
 * tool — no headless browser, so it can't render client-side JS. Most job
 * postings still work fine since the description is typically present in the
 * server-rendered HTML (search-engine indexing depends on it too); a page
 * that renders everything client-side (some ATS SPAs) will come back with
 * little/no text, which `looksLikeFailedExtraction()` in orchestrator.ts
 * already catches as a failed extraction — the user then pastes the vacancy
 * text directly (`raw_text` source), the same fallback used for a
 * Playwright bot-block failure before.
 */
export const extractContentTool: Tool<
  z.infer<typeof ExtractContentInputSchema>,
  z.infer<typeof ExtractContentOutputSchema>
> = {
  name: "web.extract_content",
  description: "Fetches the vacancy URL and extracts its visible text content (no browser, no JS rendering).",
  inputSchema: ExtractContentInputSchema,
  outputSchema: ExtractContentOutputSchema,
  async execute(input, _ctx: ToolExecutionContext) {
    const response = await fetch(input.url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`Fetching the vacancy URL failed with HTTP ${response.status} ${response.statusText}.`);
    }
    const html = await response.text();

    const $ = cheerio.load(html);
    $(NOISE_SELECTORS).remove();
    const bodyText = $("body").text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

    const rawText =
      bodyText.length > MAX_EXTRACTED_CHARS
        ? `${bodyText.slice(0, MAX_EXTRACTED_CHARS)}\n\n[... truncated at ${MAX_EXTRACTED_CHARS} characters ...]`
        : bodyText;
    return { rawText };
  },
};
