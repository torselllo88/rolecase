import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AgentName, AgentRequest, AgentResponse } from "../types/agent.js";
import type { Tracer } from "../observability/tracer.js";
import type { LlmProvider } from "../llm/provider.js";
import type { SearchBroker } from "../tools/searchBroker.js";

export interface AgentExecutionContext {
  tracer: Tracer;
  tools?: {
    searchBroker?: SearchBroker;
    /** Present only when Azure OpenAI is configured — absent means "use the deterministic stub". */
    llm?: LlmProvider;
  };
  /** Admin-configured free text appended to an agent's own system prompt — see withPromptAddendum() below. Keyed by AgentName so one shared ctx object can carry every agent's own addendum through a whole run. */
  instructions?: Partial<Record<AgentName, string>>;
}

/**
 * Additive only — never a full prompt replacement, so an agent's structured-
 * output contract (its own zod schema) can't be broken by an admin-typed
 * instruction. Every agent wraps its own systemPrompt constant with this at
 * its executeWithLlm() call site.
 */
export function withPromptAddendum(basePrompt: string, ctx: AgentExecutionContext, agentName: AgentName): string {
  const addendum = ctx.instructions?.[agentName]?.trim();
  return addendum ? `${basePrompt}\n\nAdditional operator instructions for this agent:\n${addendum}` : basePrompt;
}

/**
 * Every agent implements only `execute(input, ctx)` — it never receives a
 * reference to the orchestrator or to other agents, which is what makes
 * "agents never call each other directly" (A2A) an actual guarantee rather
 * than a convention. Only orchestrator.ts instantiates and wires agents.
 */
export abstract class BaseAgent<TInput, TOutput> {
  abstract readonly name: AgentName;
  // Input left as `unknown`: a schema using .default()/.optional() legitimately
  // accepts a looser raw input than its parsed (TInput) output type.
  abstract readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  abstract readonly outputSchema: z.ZodType<TOutput>;

  protected abstract execute(input: TInput, ctx: AgentExecutionContext): Promise<TOutput>;

  async run(
    request: AgentRequest<TInput>,
    ctx: AgentExecutionContext
  ): Promise<AgentResponse<TOutput>> {
    const startedAt = new Date().toISOString();
    const validatedInput = this.inputSchema.parse(request.input);

    try {
      const rawOutput = await this.execute(validatedInput, ctx);
      const output = this.outputSchema.parse(rawOutput);
      const response: AgentResponse<TOutput> = {
        requestId: request.requestId,
        responseId: randomUUID(),
        agent: this.name,
        status: "ok",
        output,
        metadata: { startedAt, finishedAt: new Date().toISOString() },
      };
      ctx.tracer.recordAgentCall(request, response);
      return response;
    } catch (err) {
      const response: AgentResponse<TOutput> = {
        requestId: request.requestId,
        responseId: randomUUID(),
        agent: this.name,
        status: "error",
        error: { message: err instanceof Error ? err.message : String(err) },
        metadata: { startedAt, finishedAt: new Date().toISOString() },
      };
      ctx.tracer.recordAgentCall(request, response);
      return response;
    }
  }
}

export function buildAgentRequest<TInput>(
  runId: string,
  agent: AgentName,
  input: TInput,
  context?: AgentRequest<TInput>["context"]
): AgentRequest<TInput> {
  return { requestId: randomUUID(), runId, agent, input, context };
}
