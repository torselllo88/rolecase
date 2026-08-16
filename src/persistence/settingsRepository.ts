import type { DatabaseSync } from "node:sqlite";
import type { WriterLimitsOverride } from "../config/env.js";
import type { AgentName } from "../types/agent.js";
import type { ModelConsumer } from "../llm/provider.js";

export interface AppSettings {
  defaultLimits: WriterLimitsOverride;
  defaultIncludeCoverLetter: boolean | null;
  defaultHumanizeStyle: boolean | null;
  defaultAvoidOverfitting: boolean | null;
  llmProvider: "openrouter" | "azure" | null;
  openRouterApiKey: string | null;
  openRouterModel: string | null;
  azureApiKey: string | null;
  azureEndpoint: string | null;
  azureApiVersion: string | null;
  azureDeployment: string | null;
  /** Free-text addenda appended to each agent's own system prompt, keyed by AgentName — see baseAgent.ts's withPromptAddendum(). */
  agentInstructions: Partial<Record<AgentName, string>>;
  /** Used by CompanyResearchAgent's SearchBroker — a separate credential from the LLM keys above, independently configurable so one isn't mistaken for covering both. */
  braveSearchApiKey: string | null;
  /**
   * Per-consumer OpenRouter model override, THIS workspace's own — see
   * providerFactory.ts's resolveProviderConfigs(). Independent of the admin's
   * own `.env`-level LLM_MODEL_* overrides (which used to be the only thing
   * that could win here, workspace-blind — a real bug, now fixed): this
   * workspace's own entry always wins for its own runs.
   */
  openRouterModelByConsumer: Partial<Record<ModelConsumer, string>>;
  /** Caps the Writer/Critic refinement loop for THIS workspace's runs — null means the hardcoded default (see writerCriticLoop.ts's MAX_WRITER_CRITIC_ITERATIONS). Lower = cheaper/faster, less polished. Not part of the admin-fallback cascade — same as the other generation defaults. */
  maxWriterCriticIterations: number | null;
  updatedAt: string;
}

/**
 * Everything but the two `clear*Key` flags mirrors `AppSettings` one-to-one —
 * `undefined` means "leave this field as it already is" (a partial update),
 * which is why a real API key value can't itself mean "clear" (an admin
 * might legitimately want to leave it untouched on an update that only
 * changes, say, `defaultHumanizeStyle`). Clearing a key is therefore its own
 * explicit flag rather than overloading `null`/`""`.
 */
export type AppSettingsUpdate = Partial<Omit<AppSettings, "updatedAt">> & {
  clearOpenRouterKey?: boolean;
  clearAzureKey?: boolean;
  clearBraveSearchKey?: boolean;
};

interface AppSettingsRow {
  id: number;
  default_limits_json: string | null;
  default_include_cover_letter: number | null;
  default_humanize_style: number | null;
  default_avoid_overfitting: number | null;
  llm_provider: string | null;
  openrouter_api_key: string | null;
  openrouter_model: string | null;
  azure_api_key: string | null;
  azure_endpoint: string | null;
  azure_api_version: string | null;
  azure_deployment: string | null;
  agent_instructions_json: string | null;
  brave_search_api_key: string | null;
  openrouter_model_by_consumer_json: string | null;
  max_writer_critic_iterations: number | null;
  updated_at: string;
}

function boolFromColumn(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

function rowToSettings(row: AppSettingsRow): AppSettings {
  let defaultLimits: WriterLimitsOverride = {};
  try {
    defaultLimits = row.default_limits_json ? (JSON.parse(row.default_limits_json) as WriterLimitsOverride) : {};
  } catch {
    defaultLimits = {};
  }
  let agentInstructions: Partial<Record<AgentName, string>> = {};
  try {
    agentInstructions = row.agent_instructions_json
      ? (JSON.parse(row.agent_instructions_json) as Partial<Record<AgentName, string>>)
      : {};
  } catch {
    agentInstructions = {};
  }
  let openRouterModelByConsumer: Partial<Record<ModelConsumer, string>> = {};
  try {
    openRouterModelByConsumer = row.openrouter_model_by_consumer_json
      ? (JSON.parse(row.openrouter_model_by_consumer_json) as Partial<Record<ModelConsumer, string>>)
      : {};
  } catch {
    openRouterModelByConsumer = {};
  }
  return {
    defaultLimits,
    defaultIncludeCoverLetter: boolFromColumn(row.default_include_cover_letter),
    defaultHumanizeStyle: boolFromColumn(row.default_humanize_style),
    defaultAvoidOverfitting: boolFromColumn(row.default_avoid_overfitting),
    llmProvider: row.llm_provider as AppSettings["llmProvider"],
    openRouterApiKey: row.openrouter_api_key,
    openRouterModel: row.openrouter_model,
    azureApiKey: row.azure_api_key,
    azureEndpoint: row.azure_endpoint,
    azureApiVersion: row.azure_api_version,
    azureDeployment: row.azure_deployment,
    agentInstructions,
    braveSearchApiKey: row.brave_search_api_key,
    openRouterModelByConsumer,
    maxWriterCriticIterations: row.max_writer_critic_iterations,
    updatedAt: row.updated_at,
  };
}

const EMPTY_SETTINGS: AppSettings = {
  defaultLimits: {},
  defaultIncludeCoverLetter: null,
  defaultHumanizeStyle: null,
  defaultAvoidOverfitting: null,
  llmProvider: null,
  openRouterApiKey: null,
  openRouterModel: null,
  azureApiKey: null,
  azureEndpoint: null,
  azureApiVersion: null,
  azureDeployment: null,
  agentInstructions: {},
  braveSearchApiKey: null,
  openRouterModelByConsumer: {},
  maxWriterCriticIterations: null,
  updatedAt: new Date(0).toISOString(),
};

/**
 * Single-row settings table (see 001_init.ts) — every read/write always
 * targets id=1. Mirrors RunRepository's shape even though there's only ever
 * one row, so callers don't need to special-case "settings" as a different
 * kind of thing from "a run".
 */
export class SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  getSettings(): AppSettings {
    const row = this.db.prepare(`SELECT * FROM app_settings WHERE id = 1`).get() as unknown as
      | AppSettingsRow
      | undefined;
    return row ? rowToSettings(row) : EMPTY_SETTINGS;
  }

  /**
   * Pure computation, no DB write — lets a caller (see Orchestrator.
   * updateSettings()) check whether a change would actually resolve to a
   * usable LLM provider BEFORE committing it, so an admin picking an
   * unconfigured provider never gets written into the row at all.
   */
  previewUpdate(changes: AppSettingsUpdate): AppSettings {
    const current = this.getSettings();
    // `key in changes` (not `??`) on purpose: `??` can't tell "field omitted,
    // leave alone" apart from "field explicitly sent as null, clear it back
    // to auto/.env" — e.g. resetting llmProvider from "openrouter" back to
    // null (auto-detect) needs to actually persist null, not silently no-op.
    const has = (key: keyof AppSettingsUpdate): boolean => Object.hasOwn(changes, key);
    return {
      defaultLimits: { ...current.defaultLimits, ...changes.defaultLimits },
      defaultIncludeCoverLetter: has("defaultIncludeCoverLetter")
        ? changes.defaultIncludeCoverLetter!
        : current.defaultIncludeCoverLetter,
      defaultHumanizeStyle: has("defaultHumanizeStyle") ? changes.defaultHumanizeStyle! : current.defaultHumanizeStyle,
      defaultAvoidOverfitting: has("defaultAvoidOverfitting")
        ? changes.defaultAvoidOverfitting!
        : current.defaultAvoidOverfitting,
      llmProvider: has("llmProvider") ? changes.llmProvider! : current.llmProvider,
      openRouterApiKey: changes.clearOpenRouterKey
        ? null
        : has("openRouterApiKey")
          ? changes.openRouterApiKey!
          : current.openRouterApiKey,
      openRouterModel: has("openRouterModel") ? changes.openRouterModel! : current.openRouterModel,
      azureApiKey: changes.clearAzureKey ? null : has("azureApiKey") ? changes.azureApiKey! : current.azureApiKey,
      azureEndpoint: has("azureEndpoint") ? changes.azureEndpoint! : current.azureEndpoint,
      azureApiVersion: has("azureApiVersion") ? changes.azureApiVersion! : current.azureApiVersion,
      azureDeployment: has("azureDeployment") ? changes.azureDeployment! : current.azureDeployment,
      // Shallow merge (not full replace) — same treatment as defaultLimits above,
      // so a save that only touches one agent's field doesn't need to resend every other agent's.
      agentInstructions: { ...current.agentInstructions, ...changes.agentInstructions },
      braveSearchApiKey: changes.clearBraveSearchKey
        ? null
        : has("braveSearchApiKey")
          ? changes.braveSearchApiKey!
          : current.braveSearchApiKey,
      // Shallow merge, same reasoning as agentInstructions above.
      openRouterModelByConsumer: { ...current.openRouterModelByConsumer, ...changes.openRouterModelByConsumer },
      maxWriterCriticIterations: has("maxWriterCriticIterations")
        ? changes.maxWriterCriticIterations!
        : current.maxWriterCriticIterations,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Always writes the FULL row (an upsert of every column, not just the
   * changed ones) — the same "never wipe untouched fields" discipline
   * documented throughout fileStore.ts, since a plain `UPDATE ... SET
   * changed_col = ?` on a row that doesn't exist yet would silently no-op.
   */
  updateSettings(changes: AppSettingsUpdate): AppSettings {
    const merged = this.previewUpdate(changes);

    this.db
      .prepare(
        `INSERT INTO app_settings
          (id, default_limits_json, default_include_cover_letter, default_humanize_style,
           default_avoid_overfitting, llm_provider, openrouter_api_key, openrouter_model,
           azure_api_key, azure_endpoint, azure_api_version, azure_deployment,
           agent_instructions_json, brave_search_api_key, openrouter_model_by_consumer_json,
           max_writer_critic_iterations, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           default_limits_json = excluded.default_limits_json,
           default_include_cover_letter = excluded.default_include_cover_letter,
           default_humanize_style = excluded.default_humanize_style,
           default_avoid_overfitting = excluded.default_avoid_overfitting,
           llm_provider = excluded.llm_provider,
           openrouter_api_key = excluded.openrouter_api_key,
           openrouter_model = excluded.openrouter_model,
           azure_api_key = excluded.azure_api_key,
           azure_endpoint = excluded.azure_endpoint,
           azure_api_version = excluded.azure_api_version,
           azure_deployment = excluded.azure_deployment,
           agent_instructions_json = excluded.agent_instructions_json,
           brave_search_api_key = excluded.brave_search_api_key,
           openrouter_model_by_consumer_json = excluded.openrouter_model_by_consumer_json,
           max_writer_critic_iterations = excluded.max_writer_critic_iterations,
           updated_at = excluded.updated_at`
      )
      .run(
        JSON.stringify(merged.defaultLimits),
        merged.defaultIncludeCoverLetter === null ? null : Number(merged.defaultIncludeCoverLetter),
        merged.defaultHumanizeStyle === null ? null : Number(merged.defaultHumanizeStyle),
        merged.defaultAvoidOverfitting === null ? null : Number(merged.defaultAvoidOverfitting),
        merged.llmProvider,
        merged.openRouterApiKey,
        merged.openRouterModel,
        merged.azureApiKey,
        merged.azureEndpoint,
        merged.azureApiVersion,
        merged.azureDeployment,
        JSON.stringify(merged.agentInstructions),
        merged.braveSearchApiKey,
        JSON.stringify(merged.openRouterModelByConsumer),
        merged.maxWriterCriticIterations,
        merged.updatedAt
      );

    return merged;
  }
}
