import type { AgentRequest, AgentResponse } from "../types/agent.js";
import type { TraceEvent } from "../types/trace.js";

/**
 * Buffers trace events in memory for the duration of one CLI command. The
 * orchestrator flushes the buffer into SQLite as part of its short "commit"
 * transaction — this class never touches the DB itself, so agent/tool
 * execution (which may be async) never has to happen inside a DB transaction.
 */
export class Tracer {
  private events: TraceEvent[] = [];
  private seq: number;

  constructor(private readonly runId: string, seqStart = 0) {
    this.seq = seqStart;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  recordStateTransition(fromState: string, toState: string): void {
    const now = new Date().toISOString();
    this.events.push({
      runId: this.runId,
      seq: this.nextSeq(),
      eventType: "state_transition",
      fromState,
      toState,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });
  }

  recordAgentCall<TInput, TOutput>(
    request: AgentRequest<TInput>,
    response: AgentResponse<TOutput>
  ): void {
    this.events.push({
      runId: this.runId,
      seq: this.nextSeq(),
      eventType: response.status === "error" ? "error" : "agent_call",
      agentName: request.agent,
      requestJson: request,
      responseJson: response,
      startedAt: response.metadata.startedAt,
      finishedAt: response.metadata.finishedAt,
      durationMs:
        new Date(response.metadata.finishedAt).getTime() -
        new Date(response.metadata.startedAt).getTime(),
      tokenUsage: response.metadata.tokenUsage,
      estimatedCostUsd: response.metadata.estimatedCostUsd,
      iteration: request.context?.iteration,
      createdAt: new Date().toISOString(),
    });
  }

  recordToolCall(params: {
    toolName: string;
    input: unknown;
    output: unknown;
    startedAt: string;
    finishedAt: string;
  }): void {
    this.events.push({
      runId: this.runId,
      seq: this.nextSeq(),
      eventType: "tool_call",
      toolName: params.toolName,
      requestJson: params.input,
      responseJson: params.output,
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
      durationMs: new Date(params.finishedAt).getTime() - new Date(params.startedAt).getTime(),
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Nested inside the enclosing agent_call's time range (same run, later seq)
   * rather than folded into it — an agent that makes multiple model calls
   * shows up as multiple model_call rows instead of forcing an array into one
   * column, and the trace stays a faithful record even once agents make
   * several LLM calls each.
   */
  recordModelCall(params: {
    agentName: string;
    model: string;
    tokenUsage: { promptTokens: number; completionTokens: number };
    estimatedCostUsd?: number;
    iteration?: number;
    startedAt: string;
    finishedAt: string;
  }): void {
    this.events.push({
      runId: this.runId,
      seq: this.nextSeq(),
      eventType: "model_call",
      agentName: params.agentName,
      requestJson: { model: params.model },
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
      durationMs: new Date(params.finishedAt).getTime() - new Date(params.startedAt).getTime(),
      tokenUsage: params.tokenUsage,
      estimatedCostUsd: params.estimatedCostUsd,
      iteration: params.iteration,
      createdAt: new Date().toISOString(),
    });
  }

  recordGateDecision(fromState: string, toState: string, decision: string): void {
    const now = new Date().toISOString();
    this.events.push({
      runId: this.runId,
      seq: this.nextSeq(),
      eventType: "gate_decision",
      fromState,
      toState,
      requestJson: { decision },
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });
  }

  recordError(message: string, extra?: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.events.push({
      runId: this.runId,
      seq: this.nextSeq(),
      eventType: "error",
      requestJson: extra,
      responseJson: { message },
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });
  }

  flush(): TraceEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }
}
