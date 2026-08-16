import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { buildAgentRequest, type AgentExecutionContext } from "../agents/baseAgent.js";
import {
  CompanyResearchAgent,
  CriticAgent,
  EvidenceCheckerAgent,
  ResumeSelectorAgent,
  VacancyAnalyzerAgent,
  WriterAgent,
} from "../agents/index.js";
import { NO_RESUME_IN_LIBRARY_ID } from "../agents/resumeSelectorAgent.js";
import { countWords } from "../agents/textMetrics.js";
import { env, resolveWriterLimits, type WriterLimits, type WriterLimitsOverride } from "../config/env.js";
import { Tracer } from "../observability/tracer.js";
import { createLlmProvider } from "../llm/providerFactory.js";
import type { LlmProvider } from "../llm/provider.js";
import { withTransaction } from "../persistence/db.js";
import { fileStore } from "../persistence/fileStore.js";
import { RunRepository, type RunUpdate } from "../persistence/runRepository.js";
import { SettingsRepository, type AppSettings, type AppSettingsUpdate } from "../persistence/settingsRepository.js";
import { TraceRepository } from "../persistence/traceRepository.js";
import type { WriterQuestion } from "../agents/writerAgent.js";
import { AnswerExampleLibrary } from "../tools/answerExampleLibrary.js";
import { extractContentTool } from "../tools/vacancyScraper.js";
import { CoverLetterLibrary } from "../tools/coverLetterLibrary.js";
import { CandidateNotesLibrary } from "../tools/candidateNotesLibrary.js";
import { ResumeLibrary, type ResumeCandidate } from "../tools/resumeLibrary.js";
import { SearchBroker } from "../tools/searchBroker.js";
import { AgentName } from "../types/agent.js";
import type { FitAnalysis, Recommendation, VacancyReport } from "../types/analysis.js";
import type {
  ApplicationAnswer,
  ApplicationPackage,
  EvidenceMap,
  EvidencePieceResult,
  FinalReview,
  LockedPieceReview,
  PieceInput,
} from "../types/application.js";
import type { GenerationSettings, ManualQuestion } from "../types/generationSettings.js";
import type { TraceEvent } from "../types/trace.js";
import type { VacancySourceType } from "../types/vacancy.js";
import { WorkflowState, type WorkflowRun } from "../types/workflow.js";
import {
  InvalidActionStateError,
  resolveEntryState,
  successStateFor,
  type WorkflowCommandName,
} from "./workflowState.js";
import { COVER_LETTER_PIECE_ID, MAX_WRITER_CRITIC_ITERATIONS, runWriterCriticLoop } from "./writerCriticLoop.js";

// The primary, high-confidence signal is a known bot-check/interstitial
// phrase (a Cloudflare/"are you human" challenge, a login wall) — that's
// exactly what a real vacancy posting never contains, regardless of length.
// The length floor is deliberately just a last-resort "essentially empty
// page" check (a blank body, a bare error page with no recognizable phrase)
// rather than a general "too short to be real" heuristic — a real posting's
// length varies too much across sites to safely gate on length alone without
// false-flagging genuinely short (if terse) real content. Failing fast here
// with an actionable message — instead of forwarding placeholder text to the
// LLM and surfacing whatever confused refusal it produces — points the user
// straight at the real fix: edit the vacancy source (paste the posting text
// directly) and retry, the same fallback already used when a form's fields
// can't be auto-detected.
const MIN_PLAUSIBLE_VACANCY_CHARS = 20;
const BOT_CHECK_PATTERN =
  /checking your browser|just a moment|verify you are (a )?human|are you a robot|enable javascript and cookies|access denied|security check|captcha|cloudflare|attention required/i;

/** Exported for direct unit testing — see the comment above for the reasoning. */
export function looksLikeFailedExtraction(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (trimmed.length < MIN_PLAUSIBLE_VACANCY_CHARS) return true;
  return BOT_CHECK_PATTERN.test(trimmed);
}

/** Runs with no stable snapshot to reset from — retryAnalysis/deleteRun refuse these. */
const TRANSIENT_STATES = new Set<WorkflowState>([
  WorkflowState.ANALYZING,
  WorkflowState.GENERATING_PACKAGE,
]);

function decideRecommendation(fitScore: number): Recommendation {
  if (fitScore >= 70) return "APPLY";
  if (fitScore >= 50) return "APPLY_WITH_CAUTION";
  return "REJECT";
}

function buildRecommendationNotes(recommendation: Recommendation, fitAnalysis: FitAnalysis): string {
  if (recommendation === "APPLY") {
    return `Fit score ${fitAnalysis.fitScore}/100 — strong alignment, proceed with the application.`;
  }
  if (recommendation === "APPLY_WITH_CAUTION") {
    return (
      `Fit score ${fitAnalysis.fitScore}/100 — some gaps ` +
      `(${fitAnalysis.missingSkills.join(", ") || "minor"}); apply if targeting growth.`
    );
  }
  return `Fit score ${fitAnalysis.fitScore}/100 — insufficient alignment; recommend not applying.`;
}

/**
 * Last-resort check: the Writer is prompted with the target range and the
 * Critic is asked to flag violations too, but neither is a hard guarantee —
 * this always runs afterward so an out-of-range piece is never shipped
 * without at least a visible warning. Each answer is checked against its own
 * detected `maxCharacters` (hard ATS constraint) when present, else the
 * fallback word-count-vs-`answerMaxWords` check — the warning always names
 * which unit actually applied, so there's never ambiguity. A piece that never
 * converged (see writerCriticLoop.ts's progressive locking) is skipped here
 * entirely: its length isn't a meaningful signal next to "this one still has
 * unresolved issues," which the GUI already surfaces separately.
 */
function checkLengthLimits(
  coverLetter: string,
  answers: ApplicationAnswer[],
  limits: WriterLimits,
  unconvergedPieceIds: Set<string>
): string[] {
  const { coverLetterMinWords, coverLetterMaxWords, answerMaxWords } = limits;
  const warnings: string[] = [];

  // Empty is unambiguous here — the real loop always falls back to
  // MISSING_ANSWER_PLACEHOLDER text rather than true blank, so "" only ever
  // means the cover letter was toggled off (see writerCriticLoop.ts).
  if (coverLetter && !unconvergedPieceIds.has(COVER_LETTER_PIECE_ID)) {
    const letterWords = countWords(coverLetter);
    if (letterWords < coverLetterMinWords) {
      warnings.push(`Cover letter is ${letterWords} words — below the configured minimum of ${coverLetterMinWords}.`);
    } else if (letterWords > coverLetterMaxWords) {
      warnings.push(`Cover letter is ${letterWords} words — above the configured maximum of ${coverLetterMaxWords}.`);
    }
  }

  for (const answer of answers) {
    if (unconvergedPieceIds.has(answer.id)) continue;

    if (answer.maxCharacters) {
      const answerChars = answer.answer.length;
      if (answerChars > answer.maxCharacters) {
        warnings.push(
          `Answer to "${answer.question}" is ${answerChars} characters — above the configured maximum of ${answer.maxCharacters} characters.`
        );
      }
    } else {
      const answerWords = countWords(answer.answer);
      if (answerWords > answerMaxWords) {
        warnings.push(
          `Answer to "${answer.question}" is ${answerWords} words — above the configured maximum of ${answerMaxWords} words.`
        );
      }
    }
  }

  return warnings;
}

/**
 * True when `json` parses as an object but lacks an array at `arrayKey` —
 * i.e. it's valid JSON but the pre-multi-piece shape (e.g. `final-review.json`
 * used to be `{issues, qualityScore}`, not `{pieceReviews}`). Undefined/absent
 * input is not legacy — that's just "no file yet", handled elsewhere.
 */
function hasLegacyPieceShape(json: string | undefined, arrayKey: string): boolean {
  if (!json) return false;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return !Array.isArray(parsed?.[arrayKey]);
  } catch {
    return false; // malformed JSON is a separate concern, handled by each call site's own try/catch
  }
}

/**
 * Guarantees one evidence result per piece actually sent to Evidence Checker
 * — an LLM response that omits a piece (the same class of hiccup
 * writerCriticLoop.ts already guards Critic/Writer against) would otherwise
 * leave that piece's evidence section silently absent from the GUI,
 * indistinguishable from "the checker legitimately found nothing to verify."
 * Exported for direct unit testing.
 */
export function normalizeEvidenceMap(pieces: PieceInput[], pieceResults: EvidencePieceResult[]): EvidenceMap {
  const byPieceId = new Map(pieceResults.map((r) => [r.pieceId, r]));
  return {
    pieceResults: pieces.map(
      (p) => byPieceId.get(p.id) ?? { pieceId: p.id, entries: [], unsupportedClaims: [] }
    ),
  };
}

/**
 * Resume text remains the primary evidence; cover-letter/answer excerpts are
 * appended as clearly-labeled supplementary evidence, since skills or
 * projects a candidate mentions there (but not on the resume) still belong in
 * fit-scoring — the resume alone was previously the only source, which could
 * under-score an otherwise-qualified candidate. Returns undefined only when
 * every source is empty (previously undefined whenever resumes alone were
 * empty, silently ignoring non-empty libraries). Exported for direct unit
 * testing without a real LLM/orchestrator, mirroring normalizeEvidenceMap.
 */
export function buildCandidateProfileText(
  resumes: ResumeCandidate[],
  coverLetterExamples: string[],
  answerExamples: { question: string; answer: string }[],
  candidateNotes: string[] = []
): string | undefined {
  const sections: string[] = [];

  if (resumes.length > 0) {
    sections.push(resumes.map((r) => `=== Resume: ${r.id} ===\n${r.text}`).join("\n\n"));
  }
  if (coverLetterExamples.length > 0) {
    sections.push(
      `=== Past cover letter excerpts (may reference additional skills/projects) ===\n` +
        coverLetterExamples.join("\n---\n")
    );
  }
  if (answerExamples.length > 0) {
    sections.push(
      `=== Past application answers ===\n` +
        answerExamples.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join("\n\n")
    );
  }
  if (candidateNotes.length > 0) {
    sections.push(
      `=== Additional candidate notes (background/projects not necessarily on the resume) ===\n` +
        candidateNotes.join("\n---\n")
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/**
 * Every place that grounds Writer/EvidenceChecker in "the candidate's real
 * facts" combines the resume Resume Selector chose with any free-form
 * candidate notes (see candidateNotesLibrary.ts) into one labeled string —
 * both agents already treat this field as "the primary source of truth to
 * ground claims in," and notes are the same category of source, just not
 * resume-shaped. A candidate with notes but zero resumes on file still gets
 * real grounding this way, instead of falling back to bare `strengths`.
 */
export function buildGroundingText(resumeText: string | undefined, candidateNotes: string[]): string | undefined {
  const sections: string[] = [];
  if (resumeText) sections.push(`=== Resume ===\n${resumeText}`);
  if (candidateNotes.length > 0) {
    sections.push(
      `=== Additional candidate notes (background/projects not necessarily on the resume) ===\n` +
        candidateNotes.join("\n---\n")
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

interface StepOutcome {
  runUpdate?: RunUpdate;
  onSuccessArtifacts?: () => void;
  warnings?: string[];
}

export interface StepResult {
  run: WorkflowRun;
  warnings: string[];
}

/**
 * One object instead of 5 positional optional params — `generate()` grew past
 * the point where positional args stay readable/hard-to-mis-order. Every
 * field is independently optional: omitted means "fall back to whatever's
 * already persisted in generation-settings.json, or the env/schema default
 * if nothing's persisted yet" — see generate()'s own resolution of each.
 */
export interface GenerateOverrides {
  limits?: WriterLimitsOverride;
  manualQuestions?: ManualQuestion[];
  includeCoverLetter?: boolean;
  guidanceById?: Record<string, string>;
  humanizeStyle?: boolean;
  avoidOverfitting?: boolean;
}

/** Shared context both `regeneratePiece` and `addQuestion` need — see `loadSinglePieceSetup`. */
interface SinglePieceSetup {
  report: VacancyReport;
  packageFiles: Record<string, string>;
  resumeSelectionJson: string;
  settings: GenerationSettings | undefined;
  limits: WriterLimits;
  guidanceById: Record<string, string>;
  humanizeStyle: boolean;
  avoidOverfitting: boolean;
  maxIterations: number;
  selectedResumeText: string | undefined;
  /** selectedResumeText combined with any candidate notes — see buildGroundingText(). What Writer/EvidenceChecker are actually grounded in. */
  groundingText: string | undefined;
  coverLetterExamples: string[];
  answerExamples: { question: string; answer: string }[];
}

/**
 * Drives the workflow state machine. Only this class instantiates and wires
 * the 6 agents together — agents never reference the orchestrator or each
 * other (A2A). Every public method returns plain structured data/errors, and
 * never does console I/O — that boundary is what lets a future GUI reuse this
 * class (or a thin HTTP layer over it) without touching orchestrator/agents/
 * persistence/tools. CLI commands are the only place that format and print.
 */
export class Orchestrator {
  private readonly runRepo: RunRepository;
  private readonly traceRepo: TraceRepository;
  private readonly settingsRepo: SettingsRepository;
  private readonly searchBroker: SearchBroker;
  /** Set once at construction — demo's Orchestrator is permanently stub-only, regardless of whatever its own settings row might later contain. */
  private readonly forceStubLlm: boolean;
  /** Set once at construction — demo's SearchBroker is permanently stub-only; guards refreshSearchBroker() the same way forceStubLlm guards refreshLlmProvider(). */
  private readonly forceStubSearch: boolean;
  /**
   * Workbench-only: when its own settings row has no LLM provider/key
   * configured, falls back to whatever this thunk returns (the admin
   * workspace's own settings) before finally falling back to .env inside
   * createLlmProvider() itself — a thunk, not a snapshot, so a later admin
   * settings change is picked up the next time refreshLlmProvider() runs.
   * Generation defaults (limits/includeCoverLetter/humanizeStyle) are
   * deliberately NOT part of this cascade — only the LLM connection fields.
   */
  private readonly llmFallbackSettings?: () => AppSettings;
  /**
   * Not readonly — the admin Settings page can change the provider/keys at
   * runtime (see refreshLlmProvider()), and this long-lived Orchestrator
   * instance (one per GUI server process) must pick that up without a
   * restart. undefined when nothing is configured — agents fall back to
   * their own deterministic stub.
   */
  private llmProvider: LlmProvider | undefined;
  private resumeLibrary: ResumeLibrary;
  private readonly coverLetterLibrary = new CoverLetterLibrary();
  private readonly answerExampleLibrary = new AnswerExampleLibrary();
  private readonly candidateNotesLibrary = new CandidateNotesLibrary();
  private readonly agents = {
    vacancyAnalyzer: new VacancyAnalyzerAgent(),
    companyResearch: new CompanyResearchAgent(),
    resumeSelector: new ResumeSelectorAgent(),
    writer: new WriterAgent(),
    critic: new CriticAgent(),
    evidenceChecker: new EvidenceCheckerAgent(),
  };
  /**
   * Serializes runStep() calls per run. The GUI now shares one Orchestrator
   * instance across every request, so two concurrent calls for the SAME
   * command on the SAME run (a double-click, a client retry) are routine,
   * not theoretical. Without this, resolveEntryState()'s "already in
   * inProgressState" branch — meant to let a crashed process resume a stuck
   * step — equally lets a second LIVE call into work() while the first is
   * still awaiting real I/O; both eventually commit, and whichever finishes
   * last silently clobbers the other's result.
   */
  private readonly activeSteps = new Set<string>();

  /** Used before wiping/resetting an entire workspace's data (e.g. a workbench reset) — refuses to say "safe to reset" while ANY run has a step in flight, not just a specific one. */
  hasActiveSteps(): boolean {
    return this.activeSteps.size > 0;
  }

  constructor(
    private readonly db: DatabaseSync,
    opts?: { forceStubLlm?: boolean; forceStubSearch?: boolean; llmFallbackSettings?: () => AppSettings }
  ) {
    this.runRepo = new RunRepository(db);
    this.traceRepo = new TraceRepository(db);
    this.settingsRepo = new SettingsRepository(db);
    this.forceStubLlm = opts?.forceStubLlm ?? false;
    this.forceStubSearch = opts?.forceStubSearch ?? false;
    this.llmFallbackSettings = opts?.llmFallbackSettings;
    // SearchBroker's apiKey param already exists specifically so callers can force
    // its stub path without touching env/network (searchBroker.ts) — reused here
    // for the demo workspace, which must never reach the real Brave Search API,
    // even when a real BRAVE_SEARCH_API_KEY is configured for admin/workbench.
    // Passing "" here, not undefined — SearchBroker's apiKey param defaults to
    // env.braveSearchApiKey, and JS default parameters kick in on `undefined`
    // specifically (an explicit `undefined` argument is indistinguishable from
    // omitting it entirely), so `new SearchBroker(1100, undefined)` would have
    // silently resolved back to the real env key instead of forcing the stub.
    this.searchBroker = this.forceStubSearch ? new SearchBroker(1100, "") : new SearchBroker(1100, this.resolveSearchApiKey());
    this.llmProvider = this.forceStubLlm ? undefined : createLlmProvider(this.resolveLlmSettings());
    this.resumeLibrary = new ResumeLibrary(this.llmProvider);
  }

  /**
   * Own settings' Brave Search key, falling back to llmFallbackSettings()'s
   * (workbench -> admin) when unset, then to env.braveSearchApiKey — same
   * 3-tier cascade as resolveLlmSettings(), scoped to this one field since
   * search grounding is a separate credential from the LLM connection.
   */
  private resolveSearchApiKey(): string | undefined {
    const own = this.settingsRepo.getSettings().braveSearchApiKey;
    if (own) return own;
    const fallback = this.llmFallbackSettings?.().braveSearchApiKey;
    return fallback ?? env.braveSearchApiKey;
  }

  /** Own settings row, with LLM connection fields (not generation defaults) falling back to llmFallbackSettings() when unset — see its field doc comment. */
  private resolveLlmSettings(): AppSettings {
    const own = this.settingsRepo.getSettings();
    if (!this.llmFallbackSettings) return own;
    const fallback = this.llmFallbackSettings();
    return {
      ...own,
      llmProvider: own.llmProvider ?? fallback.llmProvider,
      openRouterApiKey: own.openRouterApiKey ?? fallback.openRouterApiKey,
      openRouterModel: own.openRouterModel ?? fallback.openRouterModel,
      azureApiKey: own.azureApiKey ?? fallback.azureApiKey,
      azureEndpoint: own.azureEndpoint ?? fallback.azureEndpoint,
      azureApiVersion: own.azureApiVersion ?? fallback.azureApiVersion,
      azureDeployment: own.azureDeployment ?? fallback.azureDeployment,
      // Per-key merge (not whole-object ??) — own's per-consumer overrides win
      // per entry, falling back to the admin's own per-consumer settings for
      // any consumer this workbench hasn't overridden itself.
      openRouterModelByConsumer: { ...fallback.openRouterModelByConsumer, ...own.openRouterModelByConsumer },
    };
  }

  /**
   * Rebuilds the LLM provider (and anything constructed with a reference to
   * it) from whatever's currently in app_settings — called right after the
   * admin Settings page saves a provider/key change, so it takes effect on
   * this already-running process without a restart. Every other consumer
   * (Writer/Critic/etc, via `tools: { llm: this.llmProvider }`) reads
   * `this.llmProvider` fresh at call time, so they need no equivalent.
   * Guarded by forceStubLlm so a stub-only instance (demo) can never turn on
   * a real key even via a write to its own settings row.
   */
  refreshLlmProvider(): void {
    this.llmProvider = this.forceStubLlm ? undefined : createLlmProvider(this.resolveLlmSettings());
    this.resumeLibrary = new ResumeLibrary(this.llmProvider);
  }

  /**
   * Same idea as refreshLlmProvider(), for the Brave Search key — called
   * right after the admin Settings page saves a key change. Guarded by
   * forceStubSearch so demo's SearchBroker can never turn on a real key even
   * via a write to its own settings row.
   */
  refreshSearchBroker(): void {
    if (this.forceStubSearch) return;
    this.searchBroker.setApiKey(this.resolveSearchApiKey());
  }

  getSettings(): AppSettings {
    return this.settingsRepo.getSettings();
  }

  updateSettings(changes: AppSettingsUpdate): AppSettings {
    // Validate BEFORE persisting anything: createLlmProvider() throws loudly
    // for an explicitly-chosen-but-unconfigured provider by design (see
    // providerFactory.ts) — but that throw used to happen only after
    // settingsRepo.updateSettings() had already committed the bad row.
    // A confused admin picking "OpenRouter" without pasting a key would get
    // a 500 back and reasonably assume nothing happened — except the DB row
    // WAS updated, and this Orchestrator (and every other process sharing
    // this SQLite file) would then throw the same error on its very next
    // construction — including a server restart — with no in-app way to fix
    // it short of editing the SQLite file by hand. Previewing the merge
    // first means a bad save is rejected outright and never reaches disk.
    const preview = this.settingsRepo.previewUpdate(changes);
    createLlmProvider(preview);

    const updated = this.settingsRepo.updateSettings(changes);
    this.refreshLlmProvider();
    this.refreshSearchBroker();
    return updated;
  }

  createRun(input: {
    sourceType: VacancySourceType;
    source: string;
    visitorId?: string;
    /** Demo-only: a one-off pasted resume, used for this run alone — never written to the shared Resume Library. See loadResumeLibrary(). */
    adhocResumeText?: string;
    /** Country/location to benchmark salary research against, overriding the vacancy's own stated location — see analyze()'s use of it. */
    salaryLocationOverride?: string;
  }): WorkflowRun {
    const run = this.runRepo.createRun({
      vacancySourceType: input.sourceType,
      vacancySource: input.source,
      visitorId: input.visitorId,
      salaryLocationOverride: input.salaryLocationOverride,
    });
    if (input.adhocResumeText?.trim()) {
      fileStore.writeAdhocResumeText(run.id, input.adhocResumeText.trim());
    }
    return run;
  }

  getRun(runId: string): WorkflowRun {
    return this.runRepo.getRunOrThrow(runId);
  }

  listRuns(filter?: { state?: WorkflowState; visitorId?: string }): WorkflowRun[] {
    return this.runRepo.listRuns(filter);
  }

  /** Demo-only hygiene sweep: deletes runs older than `olderThanHours`, reusing deleteRun()'s
   *  existing guards (refuses a run that's transient or has a step in flight — simply skipped
   *  and picked up on the next sweep). Caller is responsible for scoping this to the demo
   *  workspace's own Orchestrator/context — see server.ts's sweep wiring. */
  async purgeStaleRuns(olderThanHours: number): Promise<{ deleted: string[]; skipped: string[] }> {
    const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
    const staleIds = this.runRepo.listRunIdsCreatedBefore(cutoff);
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const id of staleIds) {
      try {
        await this.deleteRun(id);
        deleted.push(id);
      } catch {
        skipped.push(id);
      }
    }
    return { deleted, skipped };
  }

  getTrace(runId: string): TraceEvent[] {
    return this.traceRepo.listByRun(runId);
  }

  getVacancyReport(runId: string): VacancyReport | undefined {
    return fileStore.readVacancyReport(runId);
  }

  getApplicationPackageFiles(runId: string): Record<string, string> {
    return fileStore.readApplicationPackageFiles(runId);
  }

  async analyze(runId: string): Promise<StepResult> {
    return this.runStep("analyze", runId, async (tracer) => {
      const run = this.runRepo.getRunOrThrow(runId);
      const appSettings = this.settingsRepo.getSettings();

      let rawText: string;
      if (run.vacancySourceType === "url") {
        const startedAt = new Date().toISOString();
        const extracted = await extractContentTool.execute({ url: run.vacancySource }, {});
        tracer.recordToolCall({
          toolName: extractContentTool.name,
          input: { url: run.vacancySource },
          output: extracted,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        rawText = extracted.rawText;
        if (looksLikeFailedExtraction(rawText)) {
          throw new Error(
            "The vacancy page could not be scraped — the extracted content looks like a bot-check, " +
              "login wall, or placeholder page rather than the real posting " +
              `(got: "${rawText.trim().slice(0, 120)}"). Edit the vacancy source (paste the job ` +
              "description text directly instead of the URL) and retry."
          );
        }
      } else {
        rawText = run.vacancySource;
      }

      const resumeLibraryResult = await this.loadResumeLibrary(runId, tracer);

      const coverLetterLibraryStartedAt = new Date().toISOString();
      const coverLetterLibraryResult = await this.coverLetterLibrary.execute({}, { runId });
      tracer.recordToolCall({
        toolName: this.coverLetterLibrary.name,
        input: {},
        output: { exampleCount: coverLetterLibraryResult.examples.length },
        startedAt: coverLetterLibraryStartedAt,
        finishedAt: new Date().toISOString(),
      });

      const answerExampleStartedAt = new Date().toISOString();
      const answerExampleResult = await this.answerExampleLibrary.execute({}, { runId });
      tracer.recordToolCall({
        toolName: this.answerExampleLibrary.name,
        input: {},
        output: { exampleCount: answerExampleResult.examples.length, truncated: answerExampleResult.truncated },
        startedAt: answerExampleStartedAt,
        finishedAt: new Date().toISOString(),
      });

      const candidateNotesStartedAt = new Date().toISOString();
      const candidateNotesResult = await this.candidateNotesLibrary.execute({}, { runId });
      tracer.recordToolCall({
        toolName: this.candidateNotesLibrary.name,
        input: {},
        output: { noteCount: candidateNotesResult.notes.length, truncated: candidateNotesResult.truncated },
        startedAt: candidateNotesStartedAt,
        finishedAt: new Date().toISOString(),
      });

      const candidateProfileText = buildCandidateProfileText(
        resumeLibraryResult.resumes,
        coverLetterLibraryResult.examples,
        answerExampleResult.examples,
        candidateNotesResult.notes
      );

      const vacancyRequest = buildAgentRequest(runId, AgentName.VACANCY_ANALYZER, {
        rawText,
        candidateProfileText,
      });
      const vacancyResponse = await this.agents.vacancyAnalyzer.run(vacancyRequest, {
        tracer,
        tools: { llm: this.llmProvider },
        instructions: appSettings.agentInstructions,
      });
      if (vacancyResponse.status === "error") throw new Error(vacancyResponse.error.message);

      const companyRequest = buildAgentRequest(runId, AgentName.COMPANY_RESEARCH, {
        companyName: vacancyResponse.output.vacancy.company,
        vacancyTitle: vacancyResponse.output.vacancy.title,
        // The run's own override (e.g. a remote worker benchmarking against
        // their own country) wins over the vacancy's own stated location.
        location: run.salaryLocationOverride?.trim() || vacancyResponse.output.vacancy.location,
      });
      const companyResponse = await this.agents.companyResearch.run(companyRequest, {
        tracer,
        tools: { searchBroker: this.searchBroker, llm: this.llmProvider },
        instructions: appSettings.agentInstructions,
      });
      if (companyResponse.status === "error") throw new Error(companyResponse.error.message);

      const recommendation = decideRecommendation(vacancyResponse.output.fitAnalysis.fitScore);
      const report: VacancyReport = {
        vacancy: vacancyResponse.output.vacancy,
        summary: vacancyResponse.output.summary,
        fitAnalysis: vacancyResponse.output.fitAnalysis,
        companyResearch: companyResponse.output,
        recommendation,
        finalRecommendationNotes: buildRecommendationNotes(
          recommendation,
          vacancyResponse.output.fitAnalysis
        ),
      };

      return {
        onSuccessArtifacts: () => fileStore.writeVacancyReport(runId, report),
        runUpdate: {
          vacancyTitle: report.vacancy.title,
          companyName: report.vacancy.company,
          recommendation: report.recommendation,
        },
      };
    });
  }

  async approve(runId: string): Promise<StepResult> {
    return this.runStep("approve", runId, async () => ({}));
  }

  async reject(runId: string): Promise<StepResult> {
    return this.runStep("reject", runId, async () => ({}));
  }

  /**
   * Explicit state-machine bypass — "re-analyze
   * from scratch" is otherwise only reachable by creating a brand new run and
   * losing this one's id/trace history. Available from every state
   * ("к каждому из обработанных или упавших") except the two transient
   * in-progress ones. Clears downstream artifacts and resets the analysis-derived run
   * fields so a retry never presents a mix of fresh and stale state, then
   * reuses the real analyze() path (including section C's library grounding)
   * rather than duplicating it.
   */
  async retryAnalysis(
    runId: string,
    sourceOverride?: { sourceType: VacancySourceType; source: string },
    /** `undefined` leaves the run's existing value untouched; `null` explicitly clears it back to "use the vacancy's own location". */
    salaryLocationOverride?: string | null
  ): Promise<StepResult> {
    const run = this.runRepo.getRunOrThrow(runId);
    if (TRANSIENT_STATES.has(run.state)) {
      throw new InvalidActionStateError("retry", run.state);
    }
    // regeneratePiece()/addQuestion() deliberately never transition run.state
    // (see their own doc comments), so TRANSIENT_STATES can't detect one in
    // flight — without this, retryAnalysis could reset the run to CREATED and
    // delete its files out from under a regenerate/add-question call still
    // reading/writing them. Everything from here to the analyze() call below
    // runs synchronously (no `await` in between), so this check and
    // analyze()'s own activeSteps registration are effectively atomic — no
    // window for another call to slip in between them.
    if (this.activeSteps.has(runId)) {
      throw new Error(`A step is already running for run ${runId} — wait for it to finish before retrying.`);
    }

    const tracer = new Tracer(runId, this.traceRepo.getMaxSeq(runId));
    tracer.recordStateTransition(run.state, WorkflowState.CREATED);
    // DB commit first, file cleanup after — mirrors deleteRun's reasoning: if
    // the commit itself throws, nothing has been deleted yet, so the run's
    // stale DB state still points at its still-intact old files rather than
    // at files that no longer exist.
    this.commit(
      runId,
      {
        state: WorkflowState.CREATED,
        errorMessage: null,
        failedFromState: null,
        vacancyTitle: null,
        companyName: null,
        recommendation: null,
        packageIterationCount: 0,
        regenerateAttemptCount: 0,
        ...(sourceOverride
          ? { vacancySourceType: sourceOverride.sourceType, vacancySource: sourceOverride.source }
          : {}),
        ...(salaryLocationOverride !== undefined ? { salaryLocationOverride } : {}),
      },
      tracer.flush()
    );
    fileStore.clearDownstreamArtifacts(runId);

    return this.analyze(runId);
  }

  /**
   * Same guard as retryAnalysis. DB rows are deleted first, inside one
   * transaction, trace_events before workflow_runs — db.ts runs `PRAGMA
   * foreign_keys = ON` and trace_events.run_id has no ON DELETE CASCADE, so
   * the reverse order would fail outright. File deletion happens after the
   * transaction commits, not inside it: if it ever fails (permissions, disk),
   * the result is harmless orphaned files, not a DB row pointing at a
   * half-deleted run.
   */
  async deleteRun(runId: string): Promise<void> {
    const run = this.runRepo.getRunOrThrow(runId);
    if (TRANSIENT_STATES.has(run.state)) {
      throw new InvalidActionStateError("delete", run.state);
    }
    // Same reasoning as retryAnalysis's identical check above — regeneratePiece()/
    // addQuestion() never transition run.state, so this is the only thing that
    // stops a delete from racing a still-in-flight one and pulling the run's
    // directory out from under it mid-write.
    if (this.activeSteps.has(runId)) {
      throw new Error(`A step is already running for run ${runId} — wait for it to finish before deleting.`);
    }

    withTransaction(this.db, () => {
      this.traceRepo.deleteByRun(runId);
      this.runRepo.deleteRun(runId);
    });
    fileStore.deleteRunDir(runId);
  }

  /**
   * `manualQuestionsOverride`, when given, replaces whatever manual questions
   * were previously persisted for this run (the GUI always sends the full,
   * pre-filled-then-edited list — see section D). When omitted (e.g. a CLI
   * regenerate), falls back to whatever's already in generation-settings.json
   * so a regenerate never silently drops questions entered via the GUI.
   */
  async generate(runId: string, overrides?: GenerateOverrides): Promise<StepResult> {
    const currentRun = this.runRepo.getRunOrThrow(runId);
    const isRegenerate = currentRun.state === WorkflowState.PACKAGE_REJECTED;
    const persistedSettings = fileStore.readGenerationSettings(runId);
    // Three-tier fallback, PER FIELD (not per whole object): this call's own
    // override -> whatever's already persisted for this run -> the
    // admin-configured app-wide default (see settingsRepository.ts) -> the
    // hardcoded/env default. Per-field matters because the GUI's generate
    // form always sends a fully-formed `overrides.limits` object (each field
    // individually `undefined` when its input is blank, but the object
    // itself is never nullish) — an object-level `??` would stop right there
    // every time, so the admin's own default (and any per-run persisted
    // value) could never actually be reached. A plain CLI/no-override
    // regenerate must never silently reset a custom limit either.
    const appSettings = this.settingsRepo.getSettings();
    const limits = resolveWriterLimits({
      coverLetterMinWords:
        overrides?.limits?.coverLetterMinWords ??
        persistedSettings?.limits?.coverLetterMinWords ??
        appSettings.defaultLimits.coverLetterMinWords,
      coverLetterMaxWords:
        overrides?.limits?.coverLetterMaxWords ??
        persistedSettings?.limits?.coverLetterMaxWords ??
        appSettings.defaultLimits.coverLetterMaxWords,
      answerMaxWords:
        overrides?.limits?.answerMaxWords ??
        persistedSettings?.limits?.answerMaxWords ??
        appSettings.defaultLimits.answerMaxWords,
    });
    // Not part of the LLM-fallback cascade — same as includeCoverLetter/
    // humanizeStyle below, this workspace's own setting only, no admin fallback.
    const maxIterations = appSettings.maxWriterCriticIterations ?? MAX_WRITER_CRITIC_ITERATIONS;
    const manualQuestions = overrides?.manualQuestions ?? persistedSettings?.manualQuestions ?? [];
    const includeCoverLetter =
      overrides?.includeCoverLetter ?? persistedSettings?.includeCoverLetter ?? appSettings.defaultIncludeCoverLetter ?? true;
    // fileStore reads are a raw JSON.parse cast (no zod .parse()/defaulting applied) — an old
    // settings file written before this field existed would otherwise come back `undefined`.
    const guidanceById = overrides?.guidanceById ?? persistedSettings?.guidanceById ?? {};
    const humanizeStyle =
      overrides?.humanizeStyle ?? persistedSettings?.humanizeStyle ?? appSettings.defaultHumanizeStyle ?? false;
    const avoidOverfitting =
      overrides?.avoidOverfitting ??
      persistedSettings?.avoidOverfitting ??
      appSettings.defaultAvoidOverfitting ??
      false;

    return this.runStep("generate", runId, async (tracer) => {
      const report = fileStore.readVacancyReport(runId);
      if (!report) throw new Error(`No vacancy report found for run ${runId}`);

      const warnings: string[] = [];
      if (isRegenerate) {
        const handEdited = fileStore.detectHandEdits(runId);
        if (handEdited.length > 0) {
          warnings.push(
            `Regenerating will overwrite hand-edited file(s): ${handEdited.join(", ")}`
          );
        }
      }

      const resumeLibraryResult = await this.loadResumeLibrary(runId, tracer);

      const resumeRequest = buildAgentRequest(runId, AgentName.RESUME_SELECTOR, {
        vacancyTitle: report.vacancy.title,
        vacancyRequirements: report.vacancy.requirements,
        vacancyKeywords: report.vacancy.keywords,
        missingSkills: report.fitAnalysis.missingSkills,
        resumes: resumeLibraryResult.resumes,
      });
      const resumeResponse = await this.agents.resumeSelector.run(resumeRequest, {
        tracer,
        tools: { llm: this.llmProvider },
        instructions: appSettings.agentInstructions,
      });
      if (resumeResponse.status === "error") throw new Error(resumeResponse.error.message);
      if (resumeResponse.output.selectedResumeId === NO_RESUME_IN_LIBRARY_ID) {
        // Otherwise this is invisible: the package still comes back
        // PACKAGE_READY with no error, and the actual note only shows up
        // inside a collapsed "Resume selection" <details> block a user has
        // to think to open — indistinguishable from a genuinely complete,
        // resume-grounded package unless they go looking.
        warnings.push(
          "No resume is on file for this application — add at least one PDF in Admin → Resumes for a properly grounded package. This one was written from your fit-analysis strengths alone."
        );
      }

      const coverLetterLibraryStartedAt = new Date().toISOString();
      const coverLetterLibraryResult = await this.coverLetterLibrary.execute({}, { runId });
      tracer.recordToolCall({
        toolName: this.coverLetterLibrary.name,
        input: {},
        output: { exampleCount: coverLetterLibraryResult.examples.length, truncated: coverLetterLibraryResult.truncated },
        startedAt: coverLetterLibraryStartedAt,
        finishedAt: new Date().toISOString(),
      });
      if (coverLetterLibraryResult.truncated) {
        warnings.push(
          "The cover letter example library exceeds the size cap — some examples were dropped (whichever fit the budget, checked in file order)."
        );
      }

      const answerExampleStartedAt = new Date().toISOString();
      const answerExampleResult = await this.answerExampleLibrary.execute({}, { runId });
      tracer.recordToolCall({
        toolName: this.answerExampleLibrary.name,
        input: {},
        output: { exampleCount: answerExampleResult.examples.length, truncated: answerExampleResult.truncated },
        startedAt: answerExampleStartedAt,
        finishedAt: new Date().toISOString(),
      });
      if (answerExampleResult.truncated) {
        warnings.push(
          "The answer example library exceeds the size cap — some examples were dropped (whichever fit the budget, checked in file order)."
        );
      }

      const candidateNotesStartedAt = new Date().toISOString();
      const candidateNotesResult = await this.candidateNotesLibrary.execute({}, { runId });
      tracer.recordToolCall({
        toolName: this.candidateNotesLibrary.name,
        input: {},
        output: { noteCount: candidateNotesResult.notes.length, truncated: candidateNotesResult.truncated },
        startedAt: candidateNotesStartedAt,
        finishedAt: new Date().toISOString(),
      });
      if (candidateNotesResult.truncated) {
        warnings.push(
          "The candidate notes library exceeds the size cap — some notes were dropped (whichever fit the budget, checked in file order)."
        );
      }

      const selectedResumeText = resumeLibraryResult.resumes.find(
        (r) => r.id === resumeResponse.output.selectedResumeId
      )?.text;
      const groundingText = buildGroundingText(selectedResumeText, candidateNotesResult.notes);

      const applicationQuestions: WriterQuestion[] = manualQuestions.map((m) => ({
        id: m.id,
        question: m.question,
        maxCharacters: m.maxCharacters,
        guidance: m.guidance,
      }));

      const loopResult = await runWriterCriticLoop(
        {
          runId,
          vacancyTitle: report.vacancy.title,
          companyName: report.vacancy.company,
          strengths: report.fitAnalysis.strengths,
          candidateResumeText: groundingText,
          vacancyRequirements: report.vacancy.requirements,
          vacancyResponsibilities: report.vacancy.responsibilities,
          styleExamples: coverLetterLibraryResult.examples,
          pastAnswerExamples: answerExampleResult.examples.map((e) => `Q: ${e.question}\nA: ${e.answer}`),
          applicationQuestions,
          generateCoverLetter: includeCoverLetter,
          coverLetterGuidance: guidanceById[COVER_LETTER_PIECE_ID],
          humanizeStyle,
          avoidOverfitting,
          limits,
          maxIterations,
        },
        { writer: this.agents.writer, critic: this.agents.critic },
        { tracer, tools: { llm: this.llmProvider }, instructions: appSettings.agentInstructions }
      );

      // No cover-letter piece at all when toggled off — nothing to evidence-check.
      const pieces: PieceInput[] = [
        ...(includeCoverLetter ? [{ id: COVER_LETTER_PIECE_ID, label: "Cover Letter", text: loopResult.coverLetter }] : []),
        ...loopResult.applicationAnswers.map((a) => ({ id: a.id, label: a.question, text: a.answer })),
      ];
      const evidenceRequest = buildAgentRequest(runId, AgentName.EVIDENCE_CHECKER, {
        pieces,
        candidateResumeText: groundingText,
      });
      const evidenceResponse = await this.agents.evidenceChecker.run(evidenceRequest, {
        tracer,
        tools: { llm: this.llmProvider },
        instructions: appSettings.agentInstructions,
      });
      if (evidenceResponse.status === "error") throw new Error(evidenceResponse.error.message);
      const evidenceMap = normalizeEvidenceMap(pieces, evidenceResponse.output.pieceResults);

      // Length limits are prompt guidance + a Critic check, not a hard
      // constraint (the LLM can still miss) — this is the last-resort signal
      // so an out-of-range piece is never shipped silently.
      const unconvergedPieceIds = new Set(
        loopResult.finalReview.pieceReviews.filter((r) => !r.converged).map((r) => r.pieceId)
      );
      warnings.push(
        ...checkLengthLimits(loopResult.coverLetter, loopResult.applicationAnswers, limits, unconvergedPieceIds)
      );

      const pkg: ApplicationPackage = {
        resumeSelection: resumeResponse.output,
        coverLetter: loopResult.coverLetter,
        applicationAnswers: loopResult.applicationAnswers,
        evidenceMap,
        finalReview: loopResult.finalReview,
        iterationsUsed: loopResult.iterationsUsed,
      };

      return {
        onSuccessArtifacts: () => {
          fileStore.writeApplicationPackage(runId, pkg);
          fileStore.writeGenerationSettings(runId, {
            limits,
            manualQuestions,
            includeCoverLetter,
            guidanceById,
            humanizeStyle,
            avoidOverfitting,
          });
        },
        runUpdate: {
          packageIterationCount: loopResult.iterationsUsed,
          regenerateAttemptCount: isRegenerate
            ? currentRun.regenerateAttemptCount + 1
            : currentRun.regenerateAttemptCount,
        },
        warnings,
      };
    });
  }

  async accept(runId: string): Promise<StepResult> {
    return this.runStep("accept", runId, async () => ({}));
  }

  async rejectPackage(runId: string): Promise<StepResult> {
    return this.runStep("reject_package", runId, async () => ({}));
  }

  /**
   * Manual "I've submitted this myself" gate — there's no browser automation
   * to prepare/verify a real submission, so this is a plain state-transition
   * with no work of its own (see workflowState.ts: PACKAGE_ACCEPTED -> DONE).
   */
  async confirmSubmit(runId: string): Promise<StepResult> {
    return this.runStep("confirm_submit", runId, async () => ({}));
  }

  /**
   * Side-action, not a state-machine step — regenerates exactly ONE piece
   * (the cover letter, or one application answer) without touching any other
   * already-locked piece, and without any workflow-state transition.
   * `runWriterCriticLoop()` already operates on whatever subset of pieces
   * it's given, so no core-loop changes were needed to support this.
   */
  async regeneratePiece(
    runId: string,
    pieceId: string,
    extraGuidance?: string,
    /** Cover letter uses the two word-count fields; a question piece uses maxCharacters. Both sticky — see below. */
    lengthOverride?: { maxCharacters?: number; coverLetterMinWords?: number; coverLetterMaxWords?: number }
  ): Promise<StepResult> {
    const run = this.runRepo.getRunOrThrow(runId);
    if (TRANSIENT_STATES.has(run.state)) {
      throw new InvalidActionStateError("regenerate_piece", run.state);
    }
    if (this.activeSteps.has(runId)) {
      throw new Error(`A step is already running for run ${runId} — wait for it to finish before starting another.`);
    }
    this.activeSteps.add(runId);

    const tracer = new Tracer(runId, this.traceRepo.getMaxSeq(runId));
    try {
      const setup = await this.loadSinglePieceSetup(runId, tracer);
      const { packageFiles, resumeSelectionJson, settings } = setup;

      const isCoverLetter = pieceId === COVER_LETTER_PIECE_ID;
      if (isCoverLetter && !packageFiles["cover-letter.md"]) {
        throw new Error(`Run ${runId} has no cover letter to regenerate (it may have been generated without one).`);
      }

      let answers: ApplicationAnswer[] = [];
      try {
        answers = packageFiles["application-answers.json"] ? JSON.parse(packageFiles["application-answers.json"]) : [];
      } catch {
        answers = [];
      }
      const targetAnswer = isCoverLetter ? undefined : answers.find((a) => a.id === pieceId);
      if (!isCoverLetter && !targetAnswer) {
        throw new Error(`No such piece "${pieceId}" in run ${runId}'s application package.`);
      }

      // Sticky — a future full regenerate() also remembers this note/limit.
      // Merged into a COPY of the full settings object: writing anything less
      // would silently wipe limits/manualQuestions/includeCoverLetter/
      // humanizeStyle, since fileStore writes are a plain JSON.stringify with
      // no schema-level defaulting to fall back on. Skippable if `settings`
      // is unexpectedly missing — losing a sticky note degrades nothing else
      // (contrast with addQuestion below, which can't skip its own write).
      const guidanceById = { ...setup.guidanceById };
      if (extraGuidance) guidanceById[pieceId] = extraGuidance;

      const manualQuestions = !isCoverLetter && lengthOverride?.maxCharacters
        ? (settings?.manualQuestions ?? []).map((m) =>
            m.id === pieceId ? { ...m, maxCharacters: lengthOverride.maxCharacters } : m
          )
        : (settings?.manualQuestions ?? []);
      const limits =
        isCoverLetter && (lengthOverride?.coverLetterMinWords || lengthOverride?.coverLetterMaxWords)
          ? resolveWriterLimits({
              coverLetterMinWords: lengthOverride.coverLetterMinWords ?? setup.limits.coverLetterMinWords,
              coverLetterMaxWords: lengthOverride.coverLetterMaxWords ?? setup.limits.coverLetterMaxWords,
              answerMaxWords: setup.limits.answerMaxWords,
            })
          : setup.limits;

      if (settings) fileStore.writeGenerationSettings(runId, { ...settings, guidanceById, manualQuestions, limits });

      const matchingManual = manualQuestions.find((m) => m.id === pieceId);
      const question: WriterQuestion | undefined = isCoverLetter
        ? undefined
        : {
            id: pieceId,
            question: targetAnswer!.question,
            maxCharacters: lengthOverride?.maxCharacters ?? matchingManual?.maxCharacters ?? targetAnswer!.maxCharacters,
            // Falls back to the manual question's own persisted guidance —
            // otherwise a plain "Regenerate this piece" with no new note
            // typed in silently drops the guidance it was created with.
            guidance: guidanceById[pieceId] ?? matchingManual?.guidance,
          };

      const {
        text: newText,
        pieceReview: newPieceReview,
        evidenceEntry: newEvidenceEntry,
        iterationsUsed,
      } = await this.runSinglePieceLoop(runId, question, { ...setup, guidanceById, limits }, tracer);

      let evidenceMap: EvidenceMap = { pieceResults: [] };
      try {
        evidenceMap = packageFiles["evidence-mapping.json"]
          ? JSON.parse(packageFiles["evidence-mapping.json"])
          : { pieceResults: [] };
      } catch {
        evidenceMap = { pieceResults: [] };
      }
      evidenceMap = {
        pieceResults: [...evidenceMap.pieceResults.filter((r) => r.pieceId !== pieceId), newEvidenceEntry],
      };

      let finalReview: FinalReview = { pieceReviews: [], converged: true };
      try {
        finalReview = packageFiles["final-review.json"]
          ? JSON.parse(packageFiles["final-review.json"])
          : { pieceReviews: [], converged: true };
      } catch {
        finalReview = { pieceReviews: [], converged: true };
      }
      const updatedPieceReviews = [
        ...finalReview.pieceReviews.filter((r) => r.pieceId !== pieceId),
        ...(newPieceReview ? [newPieceReview] : []),
      ];
      finalReview = { pieceReviews: updatedPieceReviews, converged: updatedPieceReviews.every((r) => r.converged) };

      const updatedPkg: ApplicationPackage = {
        resumeSelection: JSON.parse(resumeSelectionJson),
        coverLetter: isCoverLetter ? newText : packageFiles["cover-letter.md"] ?? "",
        applicationAnswers: isCoverLetter
          ? answers
          : answers.map((a) => (a.id === pieceId ? { ...a, answer: newText } : a)),
        recruiterNotes: packageFiles["recruiter-notes.md"],
        evidenceMap,
        finalReview,
        // packageIterationCount/regenerateAttemptCount on the run itself are
        // deliberately left untouched (see below) — iterationsUsed here just
        // carries this one piece's own loop count, unused by any reader.
        iterationsUsed,
      };
      fileStore.writeApplicationPackage(runId, updatedPkg);

      // Length-limit retrofit: checkLengthLimits() already handles both the
      // cover-letter and per-answer shapes — call it with a one-piece "shim"
      // scoped to just the piece that actually changed. A piece that never
      // converged is excluded, same as generate()'s own call — its length
      // isn't a meaningful signal next to "still has unresolved issues".
      const unconvergedPieceIds = new Set(newPieceReview && !newPieceReview.converged ? [pieceId] : []);
      const warnings: string[] = isCoverLetter
        ? checkLengthLimits(newText, [], limits, unconvergedPieceIds)
        : checkLengthLimits(
            "",
            [{ id: pieceId, question: question!.question, answer: newText, maxCharacters: question!.maxCharacters }],
            limits,
            unconvergedPieceIds
          );

      // No workflow-state transition (mirrors addQuestion below) — this
      // never touches packageIterationCount/regenerateAttemptCount either,
      // since those specifically track full-package generate() calls.
      const updatedRun = this.commit(runId, {}, tracer.flush());
      return { run: updatedRun, warnings };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracer.recordError(message);
      this.commit(runId, {}, tracer.flush());
      throw err;
    } finally {
      this.activeSteps.delete(runId);
    }
  }

  /**
   * Side-action like `regeneratePiece` — adds a brand-new question+answer to
   * an already-generated package without touching any existing piece, and
   * without any workflow-state transition. The main gap this closes:
   * `regeneratePiece` requires the piece to already exist; there was
   * previously no way to add one after the fact short of a full regenerate.
   */
  async addQuestion(
    runId: string,
    input: { question: string; maxCharacters?: number; guidance?: string }
  ): Promise<StepResult> {
    const run = this.runRepo.getRunOrThrow(runId);
    if (TRANSIENT_STATES.has(run.state)) {
      throw new InvalidActionStateError("add_question", run.state);
    }
    if (this.activeSteps.has(runId)) {
      throw new Error(`A step is already running for run ${runId} — wait for it to finish before starting another.`);
    }
    this.activeSteps.add(runId);

    const tracer = new Tracer(runId, this.traceRepo.getMaxSeq(runId));
    try {
      const setup = await this.loadSinglePieceSetup(runId, tracer);
      const { packageFiles, resumeSelectionJson, settings } = setup;

      const newId = randomUUID();
      const question: WriterQuestion = {
        id: newId,
        question: input.question,
        maxCharacters: input.maxCharacters,
        guidance: input.guidance,
      };
      const newManualQuestion: ManualQuestion = {
        id: newId,
        question: input.question,
        maxCharacters: input.maxCharacters,
        guidance: input.guidance,
      };
      // Unlike regeneratePiece's sticky-guidance write (skippable if
      // `settings` is unexpectedly missing), addQuestion's whole point is
      // persisting the new question — it must still write even then, so
      // build a fallback base from what's already resolved rather than skip.
      const baseSettings: GenerationSettings = settings ?? {
        limits: setup.limits,
        manualQuestions: [],
        includeCoverLetter: true,
        guidanceById: {},
        humanizeStyle: setup.humanizeStyle,
        avoidOverfitting: setup.avoidOverfitting,
      };
      fileStore.writeGenerationSettings(runId, {
        ...baseSettings,
        manualQuestions: [...baseSettings.manualQuestions, newManualQuestion],
      });

      const { text, pieceReview, evidenceEntry, iterationsUsed } = await this.runSinglePieceLoop(
        runId,
        question,
        setup,
        tracer
      );

      let answers: ApplicationAnswer[] = [];
      try {
        answers = packageFiles["application-answers.json"] ? JSON.parse(packageFiles["application-answers.json"]) : [];
      } catch {
        answers = [];
      }
      const newAnswer: ApplicationAnswer = {
        id: newId,
        question: input.question,
        answer: text,
        maxCharacters: input.maxCharacters,
      };

      let evidenceMap: EvidenceMap = { pieceResults: [] };
      try {
        evidenceMap = packageFiles["evidence-mapping.json"]
          ? JSON.parse(packageFiles["evidence-mapping.json"])
          : { pieceResults: [] };
      } catch {
        evidenceMap = { pieceResults: [] };
      }
      evidenceMap = { pieceResults: [...evidenceMap.pieceResults, evidenceEntry] };

      let finalReview: FinalReview = { pieceReviews: [], converged: true };
      try {
        finalReview = packageFiles["final-review.json"]
          ? JSON.parse(packageFiles["final-review.json"])
          : { pieceReviews: [], converged: true };
      } catch {
        finalReview = { pieceReviews: [], converged: true };
      }
      const updatedPieceReviews = [...finalReview.pieceReviews, ...(pieceReview ? [pieceReview] : [])];
      finalReview = { pieceReviews: updatedPieceReviews, converged: updatedPieceReviews.every((r) => r.converged) };

      const updatedPkg: ApplicationPackage = {
        resumeSelection: JSON.parse(resumeSelectionJson),
        coverLetter: packageFiles["cover-letter.md"] ?? "",
        applicationAnswers: [...answers, newAnswer],
        recruiterNotes: packageFiles["recruiter-notes.md"],
        evidenceMap,
        finalReview,
        iterationsUsed,
      };
      fileStore.writeApplicationPackage(runId, updatedPkg);

      // A piece that never converged is excluded, same as generate()'s own
      // call — see the identical reasoning in regeneratePiece above.
      const unconvergedPieceIds = new Set(pieceReview && !pieceReview.converged ? [newId] : []);
      const warnings: string[] = checkLengthLimits("", [newAnswer], setup.limits, unconvergedPieceIds);

      const updatedRun = this.commit(runId, {}, tracer.flush());
      return { run: updatedRun, warnings };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracer.recordError(message);
      this.commit(runId, {}, tracer.flush());
      throw err;
    } finally {
      this.activeSteps.delete(runId);
    }
  }

  /**
   * Shared setup for both `regeneratePiece` and `addQuestion` — everything
   * needed before either can build its own `WriterQuestion` and hand off to
   * `runSinglePieceLoop`. Both require an existing package, since neither
   * makes sense before a first `generate()` call.
   */
  private async loadSinglePieceSetup(runId: string, tracer: Tracer): Promise<SinglePieceSetup> {
    const report = fileStore.readVacancyReport(runId);
    if (!report) throw new Error(`No vacancy report found for run ${runId}`);

    const packageFiles = fileStore.readApplicationPackageFiles(runId);
    if (Object.keys(packageFiles).length === 0) {
      throw new Error(`No application package exists yet for run ${runId} — run generate first.`);
    }

    const resumeSelectionJson = packageFiles["resume-selection.json"];
    if (!resumeSelectionJson) {
      throw new Error(
        "This run's application package predates structured resume-selection tracking — " +
          "regenerate the whole package once via generate() to enable single-piece regeneration."
      );
    }
    // resume-selection.json alone doesn't prove the package is new enough:
    // it existed since before the multi-piece evidence-mapping.json/
    // final-review.json shape was introduced. A legacy-shaped file parses
    // fine as JSON but lacks pieceResults/pieceReviews arrays, which would
    // otherwise crash later with a TypeError instead of a clear message.
    if (hasLegacyPieceShape(packageFiles["evidence-mapping.json"], "pieceResults") ||
      hasLegacyPieceShape(packageFiles["final-review.json"], "pieceReviews")) {
      throw new Error(
        "This run's application package predates single-piece regeneration support " +
          "(legacy evidence-mapping.json/final-review.json shape) — " +
          "regenerate the whole package once via generate() to upgrade it."
      );
    }

    const settings = fileStore.readGenerationSettings(runId);
    const appSettings = this.settingsRepo.getSettings();
    const limits = resolveWriterLimits(settings?.limits ?? appSettings.defaultLimits);
    const guidanceById = { ...(settings?.guidanceById ?? {}) };
    const humanizeStyle = settings?.humanizeStyle ?? appSettings.defaultHumanizeStyle ?? false;
    const avoidOverfitting = settings?.avoidOverfitting ?? appSettings.defaultAvoidOverfitting ?? false;
    const maxIterations = appSettings.maxWriterCriticIterations ?? MAX_WRITER_CRITIC_ITERATIONS;

    // Resume grounding, recovered via the structured resume-selection.json
    // (see the guard above) rather than the human-readable resume-edits.md.
    let selectedResumeText: string | undefined;
    try {
      const { selectedResumeId } = JSON.parse(resumeSelectionJson) as { selectedResumeId: string };
      const resumeLibraryResult = await this.loadResumeLibrary(runId, tracer);
      selectedResumeText = resumeLibraryResult.resumes.find((r) => r.id === selectedResumeId)?.text;
    } catch {
      // Malformed file — proceed without resume grounding rather than failing outright.
    }

    const coverLetterLibraryStartedAt = new Date().toISOString();
    const coverLetterLibraryResult = await this.coverLetterLibrary.execute({}, { runId });
    tracer.recordToolCall({
      toolName: this.coverLetterLibrary.name,
      input: {},
      output: { exampleCount: coverLetterLibraryResult.examples.length },
      startedAt: coverLetterLibraryStartedAt,
      finishedAt: new Date().toISOString(),
    });

    const answerExampleStartedAt = new Date().toISOString();
    const answerExampleResult = await this.answerExampleLibrary.execute({}, { runId });
    tracer.recordToolCall({
      toolName: this.answerExampleLibrary.name,
      input: {},
      output: { exampleCount: answerExampleResult.examples.length, truncated: answerExampleResult.truncated },
      startedAt: answerExampleStartedAt,
      finishedAt: new Date().toISOString(),
    });

    const candidateNotesStartedAt = new Date().toISOString();
    const candidateNotesResult = await this.candidateNotesLibrary.execute({}, { runId });
    tracer.recordToolCall({
      toolName: this.candidateNotesLibrary.name,
      input: {},
      output: { noteCount: candidateNotesResult.notes.length, truncated: candidateNotesResult.truncated },
      startedAt: candidateNotesStartedAt,
      finishedAt: new Date().toISOString(),
    });

    return {
      report,
      packageFiles,
      resumeSelectionJson,
      settings,
      limits,
      guidanceById,
      humanizeStyle,
      avoidOverfitting,
      maxIterations,
      selectedResumeText,
      groundingText: buildGroundingText(selectedResumeText, candidateNotesResult.notes),
      coverLetterExamples: coverLetterLibraryResult.examples,
      answerExamples: answerExampleResult.examples,
    };
  }

  /**
   * Shared "generate and evidence-check exactly one piece" step —
   * `question: undefined` means the cover letter (mirrors `regeneratePiece`'s
   * own `isCoverLetter` branching before this was extracted); `addQuestion`
   * only ever passes a real question, since adding a second cover letter
   * isn't a thing.
   */
  private async runSinglePieceLoop(
    runId: string,
    question: WriterQuestion | undefined,
    setup: SinglePieceSetup,
    tracer: Tracer
  ): Promise<{
    pieceId: string;
    label: string;
    text: string;
    pieceReview: LockedPieceReview | undefined;
    evidenceEntry: EvidencePieceResult;
    iterationsUsed: number;
  }> {
    const isCoverLetter = !question;
    const pieceId = isCoverLetter ? COVER_LETTER_PIECE_ID : question!.id;
    const label = isCoverLetter ? "Cover Letter" : question!.question;
    const agentInstructions = this.settingsRepo.getSettings().agentInstructions;

    const loopResult = await runWriterCriticLoop(
      {
        runId,
        vacancyTitle: setup.report.vacancy.title,
        companyName: setup.report.vacancy.company,
        strengths: setup.report.fitAnalysis.strengths,
        candidateResumeText: setup.groundingText,
        vacancyRequirements: setup.report.vacancy.requirements,
        vacancyResponsibilities: setup.report.vacancy.responsibilities,
        styleExamples: setup.coverLetterExamples,
        pastAnswerExamples: setup.answerExamples.map((e) => `Q: ${e.question}\nA: ${e.answer}`),
        applicationQuestions: isCoverLetter ? [] : [question!],
        generateCoverLetter: isCoverLetter,
        coverLetterGuidance: isCoverLetter ? setup.guidanceById[COVER_LETTER_PIECE_ID] : undefined,
        humanizeStyle: setup.humanizeStyle,
        avoidOverfitting: setup.avoidOverfitting,
        limits: setup.limits,
        maxIterations: setup.maxIterations,
      },
      { writer: this.agents.writer, critic: this.agents.critic },
      { tracer, tools: { llm: this.llmProvider }, instructions: agentInstructions }
    );

    const text = isCoverLetter ? loopResult.coverLetter : loopResult.applicationAnswers[0]?.answer ?? "";
    const pieceReview = loopResult.finalReview.pieceReviews.find((r) => r.pieceId === pieceId);

    const pieceInput: PieceInput = { id: pieceId, label, text };
    const evidenceResponse = await this.agents.evidenceChecker.run(
      buildAgentRequest(runId, AgentName.EVIDENCE_CHECKER, {
        pieces: [pieceInput],
        candidateResumeText: setup.groundingText,
      }),
      { tracer, tools: { llm: this.llmProvider }, instructions: agentInstructions }
    );
    if (evidenceResponse.status === "error") throw new Error(evidenceResponse.error.message);
    // Same shape-safety guarantee generate() gets, just scoped to one piece.
    const normalizedEvidence = normalizeEvidenceMap([pieceInput], evidenceResponse.output.pieceResults);

    return {
      pieceId,
      label,
      text,
      pieceReview,
      evidenceEntry: normalizedEvidence.pieceResults[0]!,
      iterationsUsed: loopResult.iterationsUsed,
    };
  }

  /**
   * Shared by analyze() (fit-analysis grounding) and generate() (resume
   * selection) — each is a separate CLI invocation, possibly hours or days
   * apart, so re-fetching every time is correct: the library's contents can
   * genuinely change between them. Traced as a single tool_call; the summary
   * output (not full resume text) keeps the trace lean, and any per-resume
   * LLM cleanup pass is already traced separately inside ResumeLibrary.
   */
  private async loadResumeLibrary(
    runId: string,
    tracer: Tracer
  ): ReturnType<ResumeLibrary["execute"]> {
    const startedAt = new Date().toISOString();

    // Demo-only ad-hoc resume: a synthetic single-candidate result, never touching
    // the shared Resume Library directory (createRun() writes this file; see
    // fileStore.writeAdhocResumeText()) — so a demo visitor's pasted resume is
    // never scanned/selectable for any OTHER visitor's run.
    const adhocText = fileStore.readAdhocResumeText(runId);
    if (adhocText !== undefined) {
      const result = { resumes: [{ id: `adhoc-${runId}`, fileName: "(pasted resume)", text: adhocText }] };
      tracer.recordToolCall({
        toolName: this.resumeLibrary.name,
        input: {},
        output: { resumeCount: 1, resumeIds: [result.resumes[0]!.id], source: "adhoc" },
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return result;
    }

    const result = await this.resumeLibrary.execute({}, { runId, tracer });
    tracer.recordToolCall({
      toolName: this.resumeLibrary.name,
      input: {},
      output: {
        resumeCount: result.resumes.length,
        resumeIds: result.resumes.map((r) => r.id),
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return result;
  }

  /**
   * Implements the guard-check / run-step / commit split described in the
   * plan: SQLite transactions (BEGIN/COMMIT) must be synchronous end-to-end,
   * so agent/tool execution (async even in stub mode) can never live inside
   * one. Only the two short state commits below touch the DB inside a
   * transaction; `work()` runs unprotected in between.
   */
  private async runStep(
    command: WorkflowCommandName,
    runId: string,
    work: (tracer: Tracer) => Promise<StepOutcome>
  ): Promise<StepResult> {
    if (this.activeSteps.has(runId)) {
      throw new Error(`A step is already running for run ${runId} — wait for it to finish before starting another.`);
    }
    this.activeSteps.add(runId);
    try {
      const run = this.runRepo.getRunOrThrow(runId);
      const inProgressState = resolveEntryState(command, run.state, run.failedFromState);
      const tracer = new Tracer(runId, this.traceRepo.getMaxSeq(runId));

      if (run.state !== inProgressState) {
        tracer.recordStateTransition(run.state, inProgressState);
        this.commit(runId, { state: inProgressState, failedFromState: null }, tracer.flush());
      }

      try {
        const outcome = await work(tracer);
        outcome.onSuccessArtifacts?.();

        const successState = successStateFor(command);
        tracer.recordStateTransition(inProgressState, successState);
        const updatedRun = this.commit(
          runId,
          { state: successState, failedFromState: null, ...outcome.runUpdate },
          tracer.flush()
        );
        return { run: updatedRun, warnings: outcome.warnings ?? [] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        tracer.recordError(message);
        const updatedRun = this.commit(
          runId,
          { state: WorkflowState.FAILED, errorMessage: message, failedFromState: inProgressState },
          tracer.flush()
        );
        return { run: updatedRun, warnings: [] };
      }
    } finally {
      this.activeSteps.delete(runId);
    }
  }

  private commit(runId: string, update: RunUpdate, events: TraceEvent[]): WorkflowRun {
    return withTransaction(this.db, () => {
      const updated = this.runRepo.updateRun(runId, update);
      this.traceRepo.insertMany(events);
      return updated;
    });
  }
}

export type { AgentExecutionContext };
