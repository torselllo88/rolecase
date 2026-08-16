import { runOrchestratorStep } from "../runCommand.js";

export async function approveCommand(runId: string): Promise<void> {
  await runOrchestratorStep((orchestrator) => orchestrator.approve(runId));
}
