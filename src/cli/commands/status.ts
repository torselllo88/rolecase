import { createOrchestrator } from "../context.js";
import { printError, printRunSummary } from "../formatOutput.js";

export async function statusCommand(runId?: string): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    if (!runId) {
      const runs = orchestrator.listRuns();
      if (runs.length === 0) {
        console.log("No runs yet. Use `vacancy analyze <source>` to create one.");
        return;
      }
      runs.forEach((run) => {
        printRunSummary(run);
        console.log("");
      });
      return;
    }

    const run = orchestrator.getRun(runId);
    printRunSummary(run);

    const trace = orchestrator.getTrace(runId);
    console.log(`\nTrace (${trace.length} events):`);
    for (const event of trace) {
      const parts = [`#${event.seq}`, event.eventType];
      if (event.agentName) parts.push(event.agentName);
      if (event.toolName) parts.push(event.toolName);
      if (event.fromState || event.toState) parts.push(`${event.fromState} -> ${event.toState}`);
      if (event.durationMs !== undefined) parts.push(`${event.durationMs}ms`);
      console.log(`  ${parts.join(" | ")}`);
    }
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
