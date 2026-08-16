import { createOrchestrator } from "../context.js";
import { printError, printRunSummary, printWarnings } from "../formatOutput.js";
import type { VacancySourceType } from "../../types/vacancy.js";
import { WorkflowState } from "../../types/workflow.js";

export async function analyzeCommand(sourceType: VacancySourceType, source: string): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    const run = orchestrator.createRun({ sourceType, source });
    console.log(`Created run ${run.id}`);

    const result = await orchestrator.analyze(run.id);
    printWarnings(result.warnings);
    printRunSummary(result.run);
    if (result.run.state === WorkflowState.FAILED) process.exitCode = 1;
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
