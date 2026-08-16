import { AzureOpenAI } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { env } from "../config/env.js";
import { AgentName } from "../types/agent.js";
import type {
  GenerateStructuredParams,
  GenerateStructuredResult,
  LlmProvider,
  ModelConsumer,
} from "./provider.js";

/** Same shape as `env.azureOpenAi` — see OpenRouterProviderConfig's identical reasoning. */
export interface AzureProviderConfig {
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
  defaultDeployment?: string;
  largeDeployment?: string;
  deploymentByConsumer?: Partial<Record<ModelConsumer, string>>;
}

export function isAzureOpenAiConfigured(config: AzureProviderConfig = env.azureOpenAi): boolean {
  return Boolean(config.apiKey && config.endpoint && config.apiVersion && config.defaultDeployment);
}

export class AzureOpenAiProvider implements LlmProvider {
  private readonly client: AzureOpenAI;
  private readonly cfg: AzureProviderConfig;

  constructor(config: AzureProviderConfig = env.azureOpenAi) {
    this.cfg = config;
    const cfg = config;
    if (!cfg.apiKey || !cfg.endpoint || !cfg.apiVersion) {
      throw new Error("Azure OpenAI is not configured — check AZURE_OPENAI_* in .env or the admin Settings page");
    }
    // No `deployment` here on purpose: passing `model: <deploymentName>` per
    // request (see generateStructured) lets each consumer target its own
    // deployment without constructing a separate client per consumer.
    this.client = new AzureOpenAI({
      apiKey: cfg.apiKey,
      endpoint: cfg.endpoint,
      apiVersion: cfg.apiVersion,
    });
  }

  async generateStructured<T>(
    params: GenerateStructuredParams<T>
  ): Promise<GenerateStructuredResult<T>> {
    const deployment = this.deploymentFor(params.consumer);

    const completion = await this.client.chat.completions.parse({
      model: deployment,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
      response_format: zodResponseFormat(params.schema, params.schemaName),
    });

    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error(`Azure OpenAI (deployment: ${deployment}) returned no parsed structured output`);
    }

    return {
      data: parsed,
      model: deployment,
      tokenUsage: {
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * Resolution order: an explicit per-consumer override always wins (so
   * Writer, Critic, Resume Selector, etc. can each be pointed at a completely
   * independent deployment) -> Critic falls back to the legacy "large" alias
   * if no CRITIC-specific override is set -> everyone falls back to the base
   * deployment. Only the base deployment is required to configure Azure at
   * all; every other override is optional.
   */
  private deploymentFor(consumer: ModelConsumer): string {
    const cfg = this.cfg;
    const override = cfg.deploymentByConsumer?.[consumer];
    if (override) return override;

    if (consumer === AgentName.CRITIC && cfg.largeDeployment) {
      return cfg.largeDeployment;
    }

    if (!cfg.defaultDeployment) {
      throw new Error(`No Azure OpenAI deployment configured for "${consumer}" (set AZURE_OPENAI_DEPLOYMENT at minimum)`);
    }
    return cfg.defaultDeployment;
  }
}
