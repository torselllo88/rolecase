import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import type { ModelConsumer } from "../llm/provider.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

loadDotenv({ path: path.join(projectRoot, ".env"), quiet: true });

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  projectRoot,
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(projectRoot, "data"),
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || undefined,
  azureOpenAi: {
    apiKey: process.env.AZURE_OPENAI_API_KEY || undefined,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || undefined,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || undefined,
    /** Base fallback deployment, used by any consumer with no more specific override. */
    defaultDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || undefined,
    /** Legacy alias: Critic's fallback when AZURE_OPENAI_DEPLOYMENT_CRITIC isn't set. */
    largeDeployment: process.env.AZURE_OPENAI_DEPLOYMENT_LARGE || undefined,
    /**
     * Per-consumer overrides — each is independently optional. Resolution
     * order (see llm/azureOpenAiProvider.ts): explicit override for this
     * consumer -> (Critic only) largeDeployment -> defaultDeployment.
     */
    deploymentByConsumer: {
      VACANCY_ANALYZER: process.env.AZURE_OPENAI_DEPLOYMENT_VACANCY_ANALYZER || undefined,
      COMPANY_RESEARCH: process.env.AZURE_OPENAI_DEPLOYMENT_COMPANY_RESEARCH || undefined,
      RESUME_SELECTOR: process.env.AZURE_OPENAI_DEPLOYMENT_RESUME_SELECTOR || undefined,
      WRITER: process.env.AZURE_OPENAI_DEPLOYMENT_WRITER || undefined,
      CRITIC: process.env.AZURE_OPENAI_DEPLOYMENT_CRITIC || undefined,
      EVIDENCE_CHECKER: process.env.AZURE_OPENAI_DEPLOYMENT_EVIDENCE_CHECKER || undefined,
      RESUME_LIBRARY: process.env.AZURE_OPENAI_DEPLOYMENT_RESUME_LIBRARY || undefined,
    } satisfies Record<ModelConsumer, string | undefined>,
  },
  /** Global default guidance limits — a per-run override (GUI/CLI) takes precedence; see resolveWriterLimits(). */
  writerLimits: {
    coverLetterMinWords: parseIntEnv(process.env.WRITER_COVER_LETTER_MIN_WORDS, 200),
    coverLetterMaxWords: parseIntEnv(process.env.WRITER_COVER_LETTER_MAX_WORDS, 450),
    answerMaxWords: parseIntEnv(process.env.WRITER_ANSWER_MAX_WORDS, 150),
  },
  /**
   * No default baked in on purpose — absence is meaningfully different from an
   * explicit choice. See llm/providerFactory.ts's resolution order: explicit
   * value -> loud error if unconfigured; unset -> auto-detect (OpenRouter if
   * configured, else Azure, else full stub mode).
   */
  llmProvider: process.env.LLM_PROVIDER === "openrouter" || process.env.LLM_PROVIDER === "azure"
    ? process.env.LLM_PROVIDER
    : undefined,
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY || undefined,
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    siteUrl: process.env.OPENROUTER_SITE_URL || undefined,
    siteName: process.env.OPENROUTER_SITE_NAME || undefined,
    defaultModel: process.env.LLM_MODEL_DEFAULT || undefined,
    modelByConsumer: {
      VACANCY_ANALYZER: process.env.LLM_MODEL_VACANCY_ANALYZER || undefined,
      COMPANY_RESEARCH: process.env.LLM_MODEL_COMPANY_RESEARCH || undefined,
      RESUME_SELECTOR: process.env.LLM_MODEL_RESUME_SELECTOR || undefined,
      WRITER: process.env.LLM_MODEL_WRITER || undefined,
      CRITIC: process.env.LLM_MODEL_CRITIC || undefined,
      EVIDENCE_CHECKER: process.env.LLM_MODEL_EVIDENCE_CHECKER || undefined,
      RESUME_LIBRARY: process.env.LLM_MODEL_RESUME_LIBRARY || undefined,
    } satisfies Record<ModelConsumer, string | undefined>,
  },
  /**
   * Multi-workspace support (admin/demo/workbench). Unset ADMIN_PASSWORD means
   * "workspaces disabled" — the server behaves exactly as a single unauthenticated
   * instance (see src/gui/workspaces.ts's LEGACY_DESCRIPTOR). ENABLE_DEMO is
   * deliberately its own flag, independent of ADMIN_PASSWORD: enabling admin/
   * workbench auth must not force a public demo into existence.
   */
  adminPassword: process.env.ADMIN_PASSWORD || undefined,
  enableDemo: process.env.ENABLE_DEMO === "true",
  demoRunTtlHours: parseIntEnv(process.env.DEMO_RUN_TTL_HOURS, 48),
  demoRateLimitPerHour: parseIntEnv(process.env.DEMO_RATE_LIMIT_PER_HOUR, 10),
  /** Same expensive-action gate as demo's, but for admin/workbench — trusted users, so a higher default, but still a real cap against runaway cost from a careless or malicious workbench. */
  workspaceRateLimitPerHour: parseIntEnv(process.env.WORKSPACE_RATE_LIMIT_PER_HOUR, 30),
  loginRateLimitPerHour: parseIntEnv(process.env.LOGIN_RATE_LIMIT_PER_HOUR, 20),
  trustedClientIpHeader: (process.env.TRUSTED_CLIENT_IP_HEADER || "x-real-ip").toLowerCase(),
  cookieSecure: process.env.COOKIE_SECURE === "true",
};

export interface WriterLimits {
  coverLetterMinWords: number;
  coverLetterMaxWords: number;
  answerMaxWords: number;
}

/** A run can override any subset of the limits (e.g. from the GUI's generate form); unset fields fall back to the env defaults. */
export type WriterLimitsOverride = Partial<WriterLimits>;

/**
 * Single place that decides "what limits apply to this generate call" —
 * enforced via prompt + Critic check + a post-hoc warning, never a hard
 * crash. Both WriterAgent and CriticAgent receive the resolved values as
 * plain input fields rather than reading env.writerLimits directly, so a
 * per-run override (see Orchestrator.generate()) is the only source of truth
 * for a given call — never two places quietly disagreeing.
 */
export function resolveWriterLimits(override?: WriterLimitsOverride): WriterLimits {
  const resolved = {
    coverLetterMinWords: override?.coverLetterMinWords ?? env.writerLimits.coverLetterMinWords,
    coverLetterMaxWords: override?.coverLetterMaxWords ?? env.writerLimits.coverLetterMaxWords,
    answerMaxWords: override?.answerMaxWords ?? env.writerLimits.answerMaxWords,
  };
  // A minimum above the maximum is never meaningful (there's no length that
  // satisfies both) — checked here, the one place every override/persisted/
  // default combination actually gets resolved, rather than at each of the
  // several places a min/max pair can be submitted from.
  if (resolved.coverLetterMinWords > resolved.coverLetterMaxWords) {
    throw new Error(
      `Cover letter minimum words (${resolved.coverLetterMinWords}) cannot exceed the maximum (${resolved.coverLetterMaxWords}).`
    );
  }
  return resolved;
}
