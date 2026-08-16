import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Recommendation } from "../types/analysis.js";
import type { VacancySourceType } from "../types/vacancy.js";
import type { WorkflowRun, WorkflowState } from "../types/workflow.js";

interface WorkflowRunRow {
  id: string;
  state: string;
  vacancy_source_type: string;
  vacancy_source: string;
  vacancy_title: string | null;
  company_name: string | null;
  recommendation: string | null;
  package_iteration_count: number;
  regenerate_attempt_count: number;
  error_message: string | null;
  failed_from_state: string | null;
  visitor_id: string | null;
  salary_location_override: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    state: row.state as WorkflowState,
    vacancySourceType: row.vacancy_source_type as VacancySourceType,
    vacancySource: row.vacancy_source,
    vacancyTitle: row.vacancy_title,
    companyName: row.company_name,
    recommendation: row.recommendation as Recommendation | null,
    packageIterationCount: row.package_iteration_count,
    regenerateAttemptCount: row.regenerate_attempt_count,
    errorMessage: row.error_message,
    failedFromState: row.failed_from_state as WorkflowState | null,
    visitorId: row.visitor_id,
    salaryLocationOverride: row.salary_location_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type RunUpdate = Partial<{
  state: WorkflowState;
  vacancySourceType: VacancySourceType;
  vacancySource: string;
  vacancyTitle: string | null;
  companyName: string | null;
  recommendation: Recommendation | null;
  packageIterationCount: number;
  regenerateAttemptCount: number;
  errorMessage: string | null;
  failedFromState: WorkflowState | null;
  salaryLocationOverride: string | null;
}>;

export class RunRepository {
  constructor(private readonly db: DatabaseSync) {}

  createRun(input: {
    vacancySourceType: VacancySourceType;
    vacancySource: string;
    visitorId?: string;
    salaryLocationOverride?: string;
  }): WorkflowRun {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO workflow_runs
          (id, state, vacancy_source_type, vacancy_source, package_iteration_count,
           regenerate_attempt_count, visitor_id, salary_location_override, created_at, updated_at)
         VALUES (?, 'CREATED', ?, ?, 0, 0, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.vacancySourceType,
        input.vacancySource,
        input.visitorId ?? null,
        input.salaryLocationOverride ?? null,
        now,
        now
      );
    return this.getRunOrThrow(id);
  }

  getRun(id: string): WorkflowRun | undefined {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(id) as unknown as
      | WorkflowRunRow
      | undefined;
    return row ? rowToRun(row) : undefined;
  }

  getRunOrThrow(id: string): WorkflowRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  listRuns(filter?: { state?: WorkflowState; visitorId?: string }): WorkflowRun[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.state) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    if (filter?.visitorId) {
      clauses.push("visitor_id = ?");
      params.push(filter.visitorId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM workflow_runs${where} ORDER BY created_at DESC`)
      .all(...params) as unknown as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  /** Used by the demo workspace's retention purge sweep. */
  listRunIdsCreatedBefore(cutoffIso: string): string[] {
    const rows = this.db.prepare(`SELECT id FROM workflow_runs WHERE created_at < ?`).all(cutoffIso) as unknown as Array<{
      id: string;
    }>;
    return rows.map((r) => r.id);
  }

  updateRun(id: string, changes: RunUpdate): WorkflowRun {
    const current = this.getRunOrThrow(id);
    const merged = { ...current, ...changes, updatedAt: new Date().toISOString() };

    this.db
      .prepare(
        `UPDATE workflow_runs SET
          state = ?, vacancy_source_type = ?, vacancy_source = ?, vacancy_title = ?,
          company_name = ?, recommendation = ?, package_iteration_count = ?,
          regenerate_attempt_count = ?, error_message = ?, failed_from_state = ?,
          salary_location_override = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        merged.state,
        merged.vacancySourceType,
        merged.vacancySource,
        merged.vacancyTitle,
        merged.companyName,
        merged.recommendation,
        merged.packageIterationCount,
        merged.regenerateAttemptCount,
        merged.errorMessage,
        merged.failedFromState,
        merged.salaryLocationOverride,
        merged.updatedAt,
        id
      );
    return this.getRunOrThrow(id);
  }

  deleteRun(id: string): void {
    this.db.prepare(`DELETE FROM workflow_runs WHERE id = ?`).run(id);
  }
}
