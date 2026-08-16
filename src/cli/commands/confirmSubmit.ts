import { runOrchestratorStep } from "../runCommand.js";

export async function confirmSubmitCommand(runId: string): Promise<void> {
  await runOrchestratorStep((orchestrator) => orchestrator.confirmSubmit(runId));
}
