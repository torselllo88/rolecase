import { env } from "../config/env.js";
import type { AppSettings } from "../persistence/settingsRepository.js";
import { AzureOpenAiProvider, isAzureOpenAiConfigured, type AzureProviderConfig } from "./azureOpenAiProvider.js";
import { OpenRouterProvider, isOpenRouterConfigured, type OpenRouterProviderConfig } from "./openRouterProvider.js";
import type { LlmProvider } from "./provider.js";

/**
 * Overlays admin-panel-stored settings (see settingsRepository.ts) on top of
 * the .env defaults — a DB value wins when set, otherwise falls back to
 * .env, exactly the `override ?? persisted ?? default` convention every
 * per-run setting in this codebase already follows. Neither provider class
 * reads the global `env` singleton itself (besides its own constructor's
 * default parameter) — this is the one place that resolves the merge, so a
 * settings change can never leave the two sources disagreeing.
 */
function resolveProviderConfigs(
  settings: AppSettings
): { openRouter: OpenRouterProviderConfig; azure: AzureProviderConfig } {
  return {
    openRouter: {
      apiKey: settings.openRouterApiKey ?? env.openRouter.apiKey,
      baseUrl: env.openRouter.baseUrl,
      siteUrl: env.openRouter.siteUrl,
      siteName: env.openRouter.siteName,
      defaultModel: settings.openRouterModel ?? env.openRouter.defaultModel,
      // This workspace's own per-consumer overrides win over the admin's
      // raw .env-level ones — previously always env.openRouter.modelByConsumer
      // regardless of workspace, so a workbench had no way to escape an
      // expensive model the admin's own .env happened to pin for some
      // consumer, even with its own key/settings configured.
      modelByConsumer: { ...env.openRouter.modelByConsumer, ...settings.openRouterModelByConsumer },
    },
    azure: {
      apiKey: settings.azureApiKey ?? env.azureOpenAi.apiKey,
      endpoint: settings.azureEndpoint ?? env.azureOpenAi.endpoint,
      apiVersion: env.azureOpenAi.apiVersion,
      defaultDeployment: settings.azureDeployment ?? env.azureOpenAi.defaultDeployment,
      largeDeployment: env.azureOpenAi.largeDeployment,
      deploymentByConsumer: env.azureOpenAi.deploymentByConsumer,
    },
  };
}

/**
 * Explicit-choice-or-auto-detect resolution, so switching the default provider
 * never silently degrades an already-working setup: an explicit provider
 * choice that isn't actually configured throws (loud, not a silent stub
 * fallback); with no explicit choice, OpenRouter wins if configured, else
 * Azure, else `undefined` (full-stub-mode behavior).
 */
export function createLlmProvider(settings: AppSettings): LlmProvider | undefined {
  const provider = settings.llmProvider ?? env.llmProvider;
  const { openRouter, azure } = resolveProviderConfigs(settings);

  if (provider === "openrouter") {
    if (!isOpenRouterConfigured(openRouter)) {
      throw new Error(
        "OpenRouter is selected but not configured — set an API key/model via the admin Settings page or OPENROUTER_API_KEY/LLM_MODEL_DEFAULT in .env"
      );
    }
    return new OpenRouterProvider(openRouter);
  }
  if (provider === "azure") {
    if (!isAzureOpenAiConfigured(azure)) {
      throw new Error(
        "Azure OpenAI is selected but not configured — set it via the admin Settings page or AZURE_OPENAI_* in .env"
      );
    }
    return new AzureOpenAiProvider(azure);
  }

  if (isOpenRouterConfigured(openRouter)) return new OpenRouterProvider(openRouter);
  if (isAzureOpenAiConfigured(azure)) return new AzureOpenAiProvider(azure);
  return undefined;
}

const NO_SETTINGS: AppSettings = {
  defaultLimits: {},
  defaultIncludeCoverLetter: null,
  defaultHumanizeStyle: null,
  defaultAvoidOverfitting: null,
  llmProvider: null,
  openRouterApiKey: null,
  openRouterModel: null,
  agentInstructions: {},
  braveSearchApiKey: null,
  openRouterModelByConsumer: {},
  maxWriterCriticIterations: null,
  azureApiKey: null,
  azureEndpoint: null,
  azureApiVersion: null,
  azureDeployment: null,
  updatedAt: new Date(0).toISOString(),
};

/** Pure-.env resolution, for callers with no settings DB row to read (e.g. the MCP server entry point). */
export function createLlmProviderFromEnv(): LlmProvider | undefined {
  return createLlmProvider(NO_SETTINGS);
}
