export const AgentName = {
  VACANCY_ANALYZER: "VACANCY_ANALYZER",
  COMPANY_RESEARCH: "COMPANY_RESEARCH",
  RESUME_SELECTOR: "RESUME_SELECTOR",
  WRITER: "WRITER",
  CRITIC: "CRITIC",
  EVIDENCE_CHECKER: "EVIDENCE_CHECKER",
} as const;
export type AgentName = (typeof AgentName)[keyof typeof AgentName];

export interface AgentRequestContext {
  /** Present for writer/critic loop calls — which refinement pass this is (1-4). */
  iteration?: number;
  /** Links a Critic call back to the Writer response it is critiquing. */
  previousResponseId?: string;
}

export interface AgentRequest<TInput> {
  requestId: string;
  runId: string;
  agent: AgentName;
  input: TInput;
  context?: AgentRequestContext;
}

export interface ModelCallMetadata {
  model: string;
  purpose: string;
}

export interface AgentResponseMetadata {
  startedAt: string;
  finishedAt: string;
  /** undefined in stub mode — populated once real LLM calls are wired in. */
  tokenUsage?: { promptTokens: number; completionTokens: number };
  estimatedCostUsd?: number;
  modelCalls?: ModelCallMetadata[];
}

export type AgentResponse<TOutput> =
  | {
      requestId: string;
      responseId: string;
      agent: AgentName;
      status: "ok";
      output: TOutput;
      metadata: AgentResponseMetadata;
    }
  | {
      requestId: string;
      responseId: string;
      agent: AgentName;
      status: "error";
      error: { message: string; code?: string };
      metadata: AgentResponseMetadata;
    };
