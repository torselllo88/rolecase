import { describe, expect, it } from "vitest";
import { looksLikeFailedExtraction } from "../../src/orchestrator/orchestrator.js";

describe("looksLikeFailedExtraction", () => {
  it("flags a short bot-check/placeholder page", () => {
    expect(looksLikeFailedExtraction("Just a quick security check")).toBe(true);
  });

  it("flags a known interstitial phrase even if padded to a plausible length", () => {
    const padded = "Checking your browser before accessing the site. " + "Please wait a moment. ".repeat(10);
    expect(looksLikeFailedExtraction(padded)).toBe(true);
  });

  it("does not flag a realistic, substantive vacancy posting", () => {
    const realPosting =
      "Senior Backend Engineer at Acme Corp\n\n" +
      "We are looking for an experienced backend engineer to join our platform team. " +
      "Responsibilities include designing distributed systems, mentoring junior engineers, " +
      "and owning the reliability of our payments infrastructure. Requirements: 5+ years of " +
      "experience with Node.js or Go, strong understanding of distributed systems, and " +
      "excellent communication skills. We offer competitive compensation and remote work.";
    expect(looksLikeFailedExtraction(realPosting)).toBe(false);
  });
});
