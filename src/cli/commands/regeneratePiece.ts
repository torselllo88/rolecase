import { createOrchestrator } from "../context.js";
import { printError, printRunSummary, printWarnings } from "../formatOutput.js";

export async function regeneratePieceCommand(
  runId: string,
  pieceId: string,
  opts: { guidance?: string }
): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    const result = await orchestrator.regeneratePiece(runId, pieceId, opts.guidance);
    printWarnings(result.warnings);
    printRunSummary(result.run);
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
