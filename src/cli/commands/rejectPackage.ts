import { runOrchestratorStep } from "../runCommand.js";

export async function rejectPackageCommand(runId: string): Promise<void> {
  await runOrchestratorStep((orchestrator) => orchestrator.rejectPackage(runId));
}
