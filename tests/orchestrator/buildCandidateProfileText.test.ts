import { describe, expect, it } from "vitest";
import { buildCandidateProfileText } from "../../src/orchestrator/orchestrator.js";

describe("buildCandidateProfileText", () => {
  it("returns resume text only, unchanged, when the libraries are empty (today's existing behavior)", () => {
    const result = buildCandidateProfileText(
      [{ id: "resume-1", fileName: "resume-1.pdf", text: "Experienced engineer." }],
      [],
      []
    );
    expect(result).toBe("=== Resume: resume-1 ===\nExperienced engineer.");
  });

  it("includes cover-letter/answer library content even with zero resumes — the actual bug fix", () => {
    const result = buildCandidateProfileText(
      [],
      ["I built a scaling system for a payments platform."],
      [{ question: "Tell us about a challenge.", answer: "I led a migration under a tight deadline." }]
    );

    expect(result).toBeDefined();
    expect(result).toContain("Past cover letter excerpts");
    expect(result).toContain("I built a scaling system for a payments platform.");
    expect(result).toContain("Past application answers");
    expect(result).toContain("Q: Tell us about a challenge.");
    expect(result).toContain("A: I led a migration under a tight deadline.");
  });

  it("combines all three sources when all are present", () => {
    const result = buildCandidateProfileText(
      [{ id: "resume-1", fileName: "resume-1.pdf", text: "Resume text." }],
      ["Cover letter excerpt."],
      [{ question: "Q?", answer: "A." }]
    );

    expect(result).toContain("=== Resume: resume-1 ===");
    expect(result).toContain("Cover letter excerpt.");
    expect(result).toContain("Q: Q?\nA: A.");
  });

  it("returns undefined only when every source is empty", () => {
    expect(buildCandidateProfileText([], [], [])).toBeUndefined();
  });
});
