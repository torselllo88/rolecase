import { runOrchestratorStep } from "../runCommand.js";

export async function rejectCommand(runId: string): Promise<void> {
  await runOrchestratorStep((orchestrator) => orchestrator.reject(runId));
}
