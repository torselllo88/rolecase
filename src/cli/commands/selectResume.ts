import { createOrchestrator } from "../context.js";
import { printError, printRunSummary, printWarnings } from "../formatOutput.js";

export async function selectResumeCommand(runId: string, opts: { resume?: string }): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    const result = await orchestrator.selectResume(runId, opts.resume);
    printWarnings(result.warnings);
    const selection = orchestrator.getResumeSelection(runId);
    if (selection) {
      console.log(`Selected resume: ${selection.selectedResumeId} (${selection.source})`);
      console.log(selection.reasoning);
      for (const m of selection.suggestedModifications) console.log(`  - ${m}`);
    }
    printRunSummary(result.run);
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
