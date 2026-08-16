import { runOrchestratorStep } from "../runCommand.js";

export async function acceptCommand(runId: string): Promise<void> {
  await runOrchestratorStep((orchestrator) => orchestrator.accept(runId));
}
