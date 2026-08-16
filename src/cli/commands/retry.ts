import { createOrchestrator } from "../context.js";
import { printError, printRunSummary, printWarnings } from "../formatOutput.js";
import type { VacancySourceType } from "../../types/vacancy.js";
import { WorkflowState } from "../../types/workflow.js";

export async function retryCommand(runId: string, opts: { source?: string; type?: string }): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    const sourceOverride = opts.source
      ? {
          sourceType: (opts.type ?? (/^https?:\/\//i.test(opts.source) ? "url" : "raw_text")) as VacancySourceType,
          source: opts.source,
        }
      : undefined;

    const result = await orchestrator.retryAnalysis(runId, sourceOverride);
    printWarnings(result.warnings);
    printRunSummary(result.run);
    if (result.run.state === WorkflowState.FAILED) process.exitCode = 1;
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
