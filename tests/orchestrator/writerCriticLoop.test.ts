import { describe, expect, it } from "vitest";
import { CriticAgent } from "../../src/agents/criticAgent.js";
import { WriterAgent } from "../../src/agents/writerAgent.js";
import { Tracer } from "../../src/observability/tracer.js";
import {
  MAX_WRITER_CRITIC_ITERATIONS,
  runWriterCriticLoop,
} from "../../src/orchestrator/writerCriticLoop.js";
import { FakeLlmProvider } from "../helpers/fakeLlmProvider.js";

const TEST_LIMITS = { coverLetterMinWords: 200, coverLetterMaxWords: 450, answerMaxWords: 150 };

describe("runWriterCriticLoop", () => {
  it("stops early at iteration 3 once the critic converges", async () => {
    const tracer = new Tracer("test-run-1");
    const result = await runWriterCriticLoop(
      {
        runId: "test-run-1",
        vacancyTitle: "Engineer",
        companyName: "Acme",
        strengths: ["Leadership"],
        limits: TEST_LIMITS,
      },
      { writer: new WriterAgent(), critic: new CriticAgent() },
      { tracer }
    );

    expect(result.iterationsUsed).toBe(3);
    const coverLetterReview = result.finalReview.pieceReviews.find((r) => r.pieceId === "cover_letter");
    expect(coverLetterReview?.issues).toHaveLength(0);
    expect(coverLetterReview?.qualityScore).toBeGreaterThanOrEqual(75);
    expect(coverLetterReview?.converged).toBe(true);
    expect(result.finalReview.converged).toBe(true);
  });

  it("hits the hard cap of 4 iterations when the critic never converges", async () => {
    const tracer = new Tracer("test-run-2");
    const result = await runWriterCriticLoop(
      {
        runId: "test-run-2",
        vacancyTitle: "Engineer",
        companyName: "Acme",
        strengths: ["Leadership"],
        limits: TEST_LIMITS,
        forceNoConvergence: true,
      },
      { writer: new WriterAgent(), critic: new CriticAgent() },
      { tracer }
    );

    expect(result.iterationsUsed).toBe(MAX_WRITER_CRITIC_ITERATIONS);
    expect(result.finalReview.converged).toBe(false);
  });

  it("records one agent_call trace event per writer and critic call", async () => {
    const tracer = new Tracer("test-run-3");
    const result = await runWriterCriticLoop(
      {
        runId: "test-run-3",
        vacancyTitle: "Engineer",
        companyName: "Acme",
        strengths: ["Leadership"],
        limits: TEST_LIMITS,
      },
      { writer: new WriterAgent(), critic: new CriticAgent() },
      { tracer }
    );

    const events = tracer.flush();
    expect(events.filter((e) => e.eventType === "agent_call")).toHaveLength(result.iterationsUsed * 2);
  });

  it("produces zero application answers when no questions were asked", async () => {
    const tracer = new Tracer("test-run-4");
    const result = await runWriterCriticLoop(
      {
        runId: "test-run-4",
        vacancyTitle: "Engineer",
        companyName: "Acme",
        strengths: ["Leadership"],
        limits: TEST_LIMITS,
      },
      { writer: new WriterAgent(), critic: new CriticAgent() },
      { tracer }
    );

    expect(result.applicationAnswers).toHaveLength(0);
  });

  it("skips the cover letter entirely when generateCoverLetter is false, without touching real answers", async () => {
    const tracer = new Tracer("no-cover-letter-1");
    const result = await runWriterCriticLoop(
      {
        runId: "no-cover-letter-1",
        vacancyTitle: "Engineer",
        companyName: "Acme",
        strengths: ["Leadership"],
        applicationQuestions: [{ id: "q1", question: "Why?" }],
        generateCoverLetter: false,
        limits: TEST_LIMITS,
      },
      { writer: new WriterAgent(), critic: new CriticAgent() },
      { tracer }
    );

    expect(result.coverLetter).toBe("");
    expect(result.finalReview.pieceReviews.some((r) => r.pieceId === "cover_letter")).toBe(false);
    expect(result.applicationAnswers.find((a) => a.id === "q1")?.answer).toBeTruthy();
    expect(result.finalReview.pieceReviews.find((r) => r.pieceId === "q1")?.converged).toBe(true);
  });

  it("locks a piece as soon as it converges and never asks Writer to rewrite it again", async () => {
    const tracer = new Tracer("multi-piece-1");
    const llm = new FakeLlmProvider({
      WriterOutput: [
        {
          coverLetter: "Dear Acme, letter v1.",
          applicationAnswers: [{ id: "q1", question: "Why?", answer: "Answer v1." }],
        },
        { coverLetter: null, applicationAnswers: [{ id: "q1", question: "Why?", answer: "Answer v2, much better." }] },
      ],
      CriticReview: [
        {
          pieceReviews: [
            { pieceId: "cover_letter", issues: [], qualityScore: 90 },
            { pieceId: "q1", issues: [{ severity: "major", description: "too vague" }], qualityScore: 50 },
          ],
        },
        { pieceReviews: [{ pieceId: "q1", issues: [], qualityScore: 88 }] },
      ],
    });

    const result = await runWriterCriticLoop(
      {
        runId: "multi-piece-1",
        vacancyTitle: "Engineer",
        companyName: "Acme",
        strengths: ["Leadership"],
        applicationQuestions: [{ id: "q1", question: "Why?" }],
        limits: TEST_LIMITS,
      },
      { writer: new WriterAgent(), critic: new CriticAgent() },
      { tracer, tools: { llm } }
    );

    expect(result.iterationsUsed).toBe(2);
    expect(result.coverLetter).toBe("Dear Acme, letter v1.");

    const coverLetterReview = result.finalReview.pieceReviews.find((r) => r.pieceId === "cover_letter");
    expect(coverLetterReview?.iteration).toBe(1);
    expect(coverLetterReview?.converged).toBe(true);

    const q1Review = result.finalReview.pieceReviews.find((r) => r.pieceId === "q1");
    expect(q1Review?.iteration).toBe(2);
    expect(q1Review?.converged).toBe(true);
    expect(result.applicationAnswers.find((a) => a.id === "q1")?.answer).toBe("Answer v2, much better.");

    // Writer's second call must not have been asked to rewrite the (already-locked) cover letter.
    const writerCalls = llm.calls.filter((c) => c.schemaName === "WriterOutput");
    expect(writerCalls).toHaveLength(2);
    const secondCallPrompt = JSON.parse(writerCalls[1]!.userPrompt as string) as { includeCoverLetter: boolean };
    expect(secondCallPrompt.includeCoverLetter).toBe(false);
  });

  it("force-locks a piece with an explicit placeholder only when there is truly no text, preserving real text when only the review is missing", async () => {
    const tracer = new Tracer("missing-review-1");
    const llm = new FakeLlmProvider({
      WriterOutput: [
        { coverLetter: "v1", applicationAnswers: [] },
        { coverLetter: "v2", applicationAnswers: [] },
        { coverLetter: "v3", applicationAnswers: [] },
        { coverLetter: "v4", applicationAnswers: [] }, // never answers q1, across every iteration
      ],
      CriticReview: [
        { pieceReviews: [{ pieceId: "cover_letter", issues: [{ severity: "major", description: "weak" }], qualityScore: 50 }] },
        { pieceReviews: [{ pieceId: "cover_letter", issues: [{ severity: "major", description: "weak" }], qualityScore: 50 }] },
        { pieceReviews: [{ pieceId: "cover_letter", issues: [{ severity: "major", description: "weak" }], qualityScore: 50 }] },
        { pieceReviews: [] }, // final iteration: Critic's response omits BOTH pieces entirely
      ],
    });

    const result = await runWriterCriticLoop(
      {
        runId: "missing-review-1",
        vacancyTitle: "Engineer",
        companyName: "Acme",
        strengths: ["Leadership"],
        applicationQuestions: [{ id: "q1", question: "Why?" }],
        limits: TEST_LIMITS,
      },
      { writer: new WriterAgent(), critic: new CriticAgent() },
      { tracer, tools: { llm } }
    );

    expect(result.iterationsUsed).toBe(MAX_WRITER_CRITIC_ITERATIONS);

    const coverLetterReview = result.finalReview.pieceReviews.find((r) => r.pieceId === "cover_letter");
    expect(coverLetterReview?.converged).toBe(false);
    // Real content exists (Writer did produce it) — never replaced by a placeholder just
    // because the final review happened to be missing.
    expect(result.coverLetter).toBe("v4");

    const q1Answer = result.applicationAnswers.find((a) => a.id === "q1");
    expect(q1Answer?.answer).toBe(
      "Generation did not produce an answer for this question — please write one manually."
    );
    const q1Review = result.finalReview.pieceReviews.find((r) => r.pieceId === "q1");
    expect(q1Review?.converged).toBe(false);
    expect(q1Review?.qualityScore).toBe(0);
  });
});
