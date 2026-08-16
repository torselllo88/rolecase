import { createOrchestrator } from "../context.js";
import { printError } from "../formatOutput.js";

/**
 * Read-only: prints the vacancy report and application package artifacts for
 * a human to read. Editing happens directly on the markdown files under
 * data/runs/<runId>/ in an external editor — this command doesn't write anything.
 */
export async function reviewCommand(runId: string): Promise<void> {
  const orchestrator = createOrchestrator();
  try {
    const run = orchestrator.getRun(runId);
    console.log(`Run ${run.id} — state: ${run.state}`);

    const report = orchestrator.getVacancyReport(runId);
    if (report) {
      console.log("\n--- Vacancy Report ---");
      console.log(`Recommendation: ${report.recommendation}`);
      console.log(report.finalRecommendationNotes);
      const salary = report.companyResearch.salaryInsight;
      if (salary) {
        console.log(`Estimated salary range: ${salary.range} (source: ${salary.source}) — ${salary.sourceNote}`);
      }
    } else {
      console.log("\nNo vacancy report yet.");
    }

    const packageFiles = orchestrator.getApplicationPackageFiles(runId);
    const fileNames = Object.keys(packageFiles);
    if (fileNames.length > 0) {
      console.log("\n--- Application Package Files ---");
      for (const name of fileNames) {
        console.log(`\n# ${name}\n${packageFiles[name]}`);
      }
    } else {
      console.log("\nNo application package generated yet.");
    }
  } catch (err) {
    printError(err);
    process.exitCode = 1;
  }
}
