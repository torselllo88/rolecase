import { createOrchestrator } from "../context.js";
import { printError, printRunSummary, printWarnings } from "../formatOutput.js";

export async function addQuestionCommand(
  runId: string,
  question: string,
  opts: { maxChars?: string; guidance?: string }
): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    const maxCharacters = opts.maxChars ? Number.parseInt(opts.maxChars, 10) : undefined;
    const result = await orchestrator.addQuestion(runId, {
      question,
      maxCharacters: maxCharacters && Number.isFinite(maxCharacters) && maxCharacters > 0 ? maxCharacters : undefined,
      guidance: opts.guidance,
    });
    printWarnings(result.warnings);
    printRunSummary(result.run);
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
