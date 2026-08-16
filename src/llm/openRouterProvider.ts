import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { env } from "../config/env.js";
import type {
  GenerateStructuredParams,
  GenerateStructuredResult,
  LlmProvider,
  ModelConsumer,
} from "./provider.js";

/** Same shape as `env.openRouter` — lets a caller (see providerFactory.ts) overlay admin-panel-stored settings on top of the .env defaults without this class ever reading the global `env` singleton itself. */
export interface OpenRouterProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  defaultModel?: string;
  modelByConsumer?: Partial<Record<ModelConsumer, string>>;
}

export function isOpenRouterConfigured(config: OpenRouterProviderConfig = env.openRouter): boolean {
  return Boolean(config.apiKey && config.defaultModel);
}

/**
 * The `openai` SDK's APIError.message is just `"${status} ${error.message}"`
 * — for OpenRouter specifically, `error.message` is often a generic wrapper
 * ("Provider returned error") while the actual upstream provider's real
 * error text lives one level deeper, at `error.metadata.raw` (OpenRouter's
 * documented passthrough-error shape). Without this, every provider-side
 * rejection looks identical and undiagnosable from the message alone.
 */
function extractOpenRouterErrorDetail(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const metadata = (err as { error?: { metadata?: { raw?: unknown; provider_name?: unknown } } })?.error?.metadata;
  if (!metadata) return base;

  const raw = typeof metadata.raw === "string" ? metadata.raw : metadata.raw ? JSON.stringify(metadata.raw) : undefined;
  const provider = typeof metadata.provider_name === "string" ? metadata.provider_name : undefined;
  if (!raw) return base;
  return `${base} (upstream provider${provider ? ` "${provider}"` : ""} said: ${raw})`;
}

export class OpenRouterProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly cfg: OpenRouterProviderConfig;

  constructor(config: OpenRouterProviderConfig = env.openRouter) {
    this.cfg = config;
    const cfg = config;
    if (!cfg.apiKey) {
      throw new Error("OpenRouter is not configured — check OPENROUTER_API_KEY in .env or the admin Settings page");
    }
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl ?? env.openRouter.baseUrl,
      defaultHeaders: {
        ...(cfg.siteUrl ? { "HTTP-Referer": cfg.siteUrl } : {}),
        ...(cfg.siteName ? { "X-Title": cfg.siteName } : {}),
      },
    });
  }

  async generateStructured<T>(
    params: GenerateStructuredParams<T>
  ): Promise<GenerateStructuredResult<T>> {
    const model = this.modelFor(params.consumer);

    let completion;
    try {
      completion = await this.client.chat.completions.parse({
        model,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
        response_format: zodResponseFormat(params.schema, params.schemaName),
      });
    } catch (err) {
      throw new Error(`OpenRouter (model: ${model}) request failed: ${extractOpenRouterErrorDetail(err)}`);
    }

    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error(`OpenRouter (model: ${model}) returned no parsed structured output`);
    }

    return {
      data: parsed,
      model,
      tokenUsage: {
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * Resolution order: an explicit per-consumer override always wins -> everyone
   * else falls back to the shared default model. Only the default model is
   * required to configure OpenRouter at all; every per-consumer override is
   * optional.
   */
  private modelFor(consumer: ModelConsumer): string {
    const cfg = this.cfg;
    const override = cfg.modelByConsumer?.[consumer];
    if (override) return override;

    if (!cfg.defaultModel) {
      throw new Error(`No OpenRouter model configured for "${consumer}" (set LLM_MODEL_DEFAULT at minimum)`);
    }
    return cfg.defaultModel;
  }
}
