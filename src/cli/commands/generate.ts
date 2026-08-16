import { runOrchestratorStep } from "../runCommand.js";

export async function generateCommand(runId: string): Promise<void> {
  await runOrchestratorStep((orchestrator) => orchestrator.generate(runId));
}
