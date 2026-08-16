import { createInterface } from "node:readline/promises";
import { createOrchestrator } from "../context.js";
import { printError } from "../formatOutput.js";

export async function deleteRunCommand(runId: string, opts: { yes?: boolean }): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `Permanently delete run ${runId}? This cannot be undone. Type "yes" to confirm: `
      );
      rl.close();
      if (answer.trim().toLowerCase() !== "yes") {
        console.log("Aborted — run not deleted.");
        return;
      }
    }

    await orchestrator.deleteRun(runId);
    console.log(`Deleted run ${runId}`);
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
