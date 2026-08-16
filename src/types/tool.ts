import type { z } from "zod";
import type { Tracer } from "../observability/tracer.js";

export interface ToolExecutionContext {
  runId?: string;
  /**
   * Present when a tool may itself make LLM calls (e.g. ResumeLibrary's
   * text-cleanup pass) — lets those calls show up as model_call trace events
   * instead of being hidden inside a tool_call, per "traceability over hidden
   * reasoning". Absent for tools that never call a model.
   */
  tracer?: Tracer;
}

/**
 * Mirrors the MCP tool shape (name, description, inputSchema, execute) closely
 * enough that a future real MCP server wrapper is a thin adapter, not a rewrite:
 * `tools/list` would map over an array of these, `tools/call` would invoke `execute()`.
 */
export interface Tool<TInput, TOutput> {
  name: string;
  description: string;
  // Input left as `unknown`: a schema using .default()/.optional() legitimately
  // accepts a looser raw input than its parsed (TInput) output type.
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<TOutput>;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
}
