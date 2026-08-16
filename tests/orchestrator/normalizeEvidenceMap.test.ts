import { describe, expect, it } from "vitest";
import { normalizeEvidenceMap } from "../../src/orchestrator/orchestrator.js";

describe("normalizeEvidenceMap", () => {
  it("passes through a complete response unchanged", () => {
    const pieces = [
      { id: "cover_letter", label: "Cover Letter", text: "..." },
      { id: "q1", label: "Why?", text: "..." },
    ];
    const result = normalizeEvidenceMap(pieces, [
      { pieceId: "cover_letter", entries: [], unsupportedClaims: [] },
      { pieceId: "q1", entries: [], unsupportedClaims: [] },
    ]);

    expect(result.pieceResults.map((r) => r.pieceId)).toEqual(["cover_letter", "q1"]);
  });

  it("fills in an empty result for a piece the LLM response omitted, rather than dropping it", () => {
    const pieces = [
      { id: "cover_letter", label: "Cover Letter", text: "..." },
      { id: "q1", label: "Why?", text: "..." },
    ];
    const result = normalizeEvidenceMap(pieces, [
      { pieceId: "cover_letter", entries: [{ claim: "led a team", evidence: ["Team Lead"], supported: true }], unsupportedClaims: [] },
      // q1 missing entirely — simulates an incomplete LLM response
    ]);

    expect(result.pieceResults.map((r) => r.pieceId)).toEqual(["cover_letter", "q1"]);
    const q1Result = result.pieceResults.find((r) => r.pieceId === "q1");
    expect(q1Result).toEqual({ pieceId: "q1", entries: [], unsupportedClaims: [] });
  });

  it("ignores an extra, unrequested pieceId in the response", () => {
    const pieces = [{ id: "cover_letter", label: "Cover Letter", text: "..." }];
    const result = normalizeEvidenceMap(pieces, [
      { pieceId: "cover_letter", entries: [], unsupportedClaims: [] },
      { pieceId: "hallucinated_extra", entries: [], unsupportedClaims: [] },
    ]);

    expect(result.pieceResults).toHaveLength(1);
    expect(result.pieceResults[0]?.pieceId).toBe("cover_letter");
  });
});
