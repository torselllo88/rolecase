import type { WorkflowRun } from "../types/workflow.js";

/**
 * The only place in this codebase that formats data for a terminal — the
 * orchestrator returns plain structured data so a future GUI presentation
 * layer can format the same data differently without touching orchestrator.ts.
 */
export function printRunSummary(run: WorkflowRun): void {
  console.log(`Run ${run.id}`);
  console.log(`  state: ${run.state}`);
  if (run.vacancyTitle) console.log(`  vacancy: ${run.vacancyTitle} @ ${run.companyName ?? "?"}`);
  if (run.recommendation) console.log(`  recommendation: ${run.recommendation}`);
  if (run.errorMessage) console.log(`  error: ${run.errorMessage}`);
}

export function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
}

export function printError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
}
