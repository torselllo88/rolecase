import type { DatabaseSync } from "node:sqlite";
import type { TraceEvent, TraceEventType } from "../types/trace.js";

interface TraceEventRow {
  id: number;
  run_id: string;
  seq: number;
  event_type: string;
  agent_name: string | null;
  tool_name: string | null;
  request_json: string | null;
  response_json: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  token_usage_json: string | null;
  estimated_cost_usd: number | null;
  iteration: number | null;
  from_state: string | null;
  to_state: string | null;
  created_at: string;
}

function rowToEvent(row: TraceEventRow): TraceEvent {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    eventType: row.event_type as TraceEventType,
    agentName: row.agent_name ?? undefined,
    toolName: row.tool_name ?? undefined,
    requestJson: row.request_json ? JSON.parse(row.request_json) : undefined,
    responseJson: row.response_json ? JSON.parse(row.response_json) : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    tokenUsage: row.token_usage_json ? JSON.parse(row.token_usage_json) : undefined,
    estimatedCostUsd: row.estimated_cost_usd ?? undefined,
    iteration: row.iteration ?? undefined,
    fromState: row.from_state ?? undefined,
    toState: row.to_state ?? undefined,
    createdAt: row.created_at,
  };
}

export class TraceRepository {
  constructor(private readonly db: DatabaseSync) {}

  getMaxSeq(runId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) as maxSeq FROM trace_events WHERE run_id = ?`)
      .get(runId) as unknown as { maxSeq: number | null };
    return row.maxSeq ?? 0;
  }

  /**
   * No transaction of its own — node:sqlite's DatabaseSync has no
   * `.transaction()` helper, and every real caller (Orchestrator.commit)
   * already wraps this inside its own withTransaction() alongside the run
   * update, so wrapping here too would mean nested BEGINs, which SQLite
   * doesn't support without savepoints.
   */
  insertMany(events: TraceEvent[]): void {
    if (events.length === 0) return;

    const stmt = this.db.prepare(
      `INSERT INTO trace_events
        (run_id, seq, event_type, agent_name, tool_name, request_json, response_json,
         started_at, finished_at, duration_ms, token_usage_json, estimated_cost_usd,
         iteration, from_state, to_state, created_at)
       VALUES (@runId, @seq, @eventType, @agentName, @toolName, @requestJson, @responseJson,
         @startedAt, @finishedAt, @durationMs, @tokenUsageJson, @estimatedCostUsd,
         @iteration, @fromState, @toState, @createdAt)`
    );

    for (const event of events) {
      stmt.run({
        runId: event.runId,
        seq: event.seq,
        eventType: event.eventType,
        agentName: event.agentName ?? null,
        toolName: event.toolName ?? null,
        requestJson: event.requestJson !== undefined ? JSON.stringify(event.requestJson) : null,
        responseJson:
          event.responseJson !== undefined ? JSON.stringify(event.responseJson) : null,
        startedAt: event.startedAt,
        finishedAt: event.finishedAt ?? null,
        durationMs: event.durationMs ?? null,
        tokenUsageJson: event.tokenUsage ? JSON.stringify(event.tokenUsage) : null,
        estimatedCostUsd: event.estimatedCostUsd ?? null,
        iteration: event.iteration ?? null,
        fromState: event.fromState ?? null,
        toState: event.toState ?? null,
        createdAt: event.createdAt,
      });
    }
  }

  listByRun(runId: string): TraceEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM trace_events WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId) as unknown as TraceEventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * No transaction of its own, same reasoning as insertMany — callers (here,
   * Orchestrator.deleteRun) must run this inside their own withTransaction()
   * alongside the workflow_runs delete, and must run it FIRST: trace_events.run_id
   * references workflow_runs(id) with no ON DELETE CASCADE, under foreign_keys = ON.
   */
  deleteByRun(runId: string): void {
    this.db.prepare(`DELETE FROM trace_events WHERE run_id = ?`).run(runId);
  }
}
