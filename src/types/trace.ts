export const TraceEventType = {
  STATE_TRANSITION: "state_transition",
  AGENT_CALL: "agent_call",
  TOOL_CALL: "tool_call",
  MODEL_CALL: "model_call",
  GATE_DECISION: "gate_decision",
  ERROR: "error",
} as const;
export type TraceEventType = (typeof TraceEventType)[keyof typeof TraceEventType];

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface TraceEvent {
  id?: number;
  runId: string;
  seq: number;
  eventType: TraceEventType;
  agentName?: string;
  toolName?: string;
  requestJson?: unknown;
  responseJson?: unknown;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  tokenUsage?: TokenUsage;
  estimatedCostUsd?: number;
  iteration?: number;
  fromState?: string;
  toState?: string;
  createdAt: string;
}
