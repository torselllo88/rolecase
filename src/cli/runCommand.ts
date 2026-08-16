import { createOrchestrator } from "./context.js";
import { printError, printRunSummary, printWarnings } from "./formatOutput.js";
import type { Orchestrator, StepResult } from "../orchestrator/orchestrator.js";
import { WorkflowState } from "../types/workflow.js";

/**
 * Shared shape for every command that just drives one orchestrator state
 * transition and prints the result — avoids repeating the same try/catch and
 * printing boilerplate across analyze/approve/reject/generate/accept/etc.
 */
export async function runOrchestratorStep(
  step: (orchestrator: Orchestrator) => Promise<StepResult>
): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    const result = await step(orchestrator);
    printWarnings(result.warnings);
    printRunSummary(result.run);
    if (result.run.state === WorkflowState.FAILED) process.exitCode = 1;
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
