import type { z } from "zod";
import type { AgentName } from "../types/agent.js";

/**
 * Who is asking for a model call — one of the 6 real agents, or a tool-level
 * consumer (currently only ResumeLibrary's text-cleanup pass). Each consumer
 * can be pointed at its own deployment independently (see config/env.ts's
 * `azureOpenAi.deploymentByConsumer`), not just a shared "default"/"large"
 * pair — e.g. Writer on gpt-4o-mini, Critic on gpt-4.1, Resume Selector on a
 * third model, all configured independently via one env var each.
 */
export type ModelConsumer = AgentName | "RESUME_LIBRARY";

export interface GenerateStructuredParams<T> {
  consumer: ModelConsumer;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  /** Short identifier for the schema, required by the structured-output API. */
  schemaName: string;
}

export interface GenerateStructuredResult<T> {
  data: T;
  /** The deployment/model name that actually served the request. */
  model: string;
  tokenUsage: { promptTokens: number; completionTokens: number };
}

/**
 * Model-provider abstraction per README's "replaceable models and tools"
 * principle — agents depend on this interface, not on Azure/OpenAI directly.
 */
export interface LlmProvider {
  generateStructured<T>(params: GenerateStructuredParams<T>): Promise<GenerateStructuredResult<T>>;
}
