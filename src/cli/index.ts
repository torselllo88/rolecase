#!/usr/bin/env node
import { Command } from "commander";
import { acceptCommand } from "./commands/accept.js";
import { addQuestionCommand } from "./commands/addQuestion.js";
import { analyzeCommand } from "./commands/analyze.js";
import { approveCommand } from "./commands/approve.js";
import { confirmSubmitCommand } from "./commands/confirmSubmit.js";
import { deleteRunCommand } from "./commands/deleteRun.js";
import { generateCommand } from "./commands/generate.js";
import { regeneratePieceCommand } from "./commands/regeneratePiece.js";
import { rejectCommand } from "./commands/reject.js";
import { rejectPackageCommand } from "./commands/rejectPackage.js";
import { retryCommand } from "./commands/retry.js";
import { reviewCommand } from "./commands/review.js";
import { statusCommand } from "./commands/status.js";
import type { VacancySourceType } from "../types/vacancy.js";

const program = new Command();

program
  .name("rolecase")
  .description(
    "RoleCase CLI — an AI assistant for evaluating job opportunities and drafting tailored applications, with human approval at every step."
  );

program
  .command("analyze")
  .description("Create a run and analyze a vacancy (URL or raw text)")
  .argument("<source>", "vacancy URL or raw text")
  .option("--type <type>", "url|raw_text (auto-detected from the source if omitted)")
  .action(async (source: string, opts: { type?: string }) => {
    const sourceType = (opts.type ?? (/^https?:\/\//i.test(source) ? "url" : "raw_text")) as VacancySourceType;
    await analyzeCommand(sourceType, source);
  });

program
  .command("approve")
  .description("Approve the vacancy analysis (gate 1) -> ANALYSIS_APPROVED")
  .argument("<runId>")
  .action(approveCommand);

program
  .command("reject")
  .description("Reject the vacancy analysis (gate 1) -> REJECTED (terminal)")
  .argument("<runId>")
  .action(rejectCommand);

program
  .command("generate")
  .description("Generate (or regenerate) the application package -> PACKAGE_READY")
  .argument("<runId>")
  .action(generateCommand);

program
  .command("regenerate-piece")
  .description(
    "Regenerate exactly one piece of an existing application package (the cover letter, or one " +
      "answer's id) without touching any other piece. Does not change the run's workflow state."
  )
  .argument("<runId>")
  .argument("<pieceId>", 'the piece id — "cover_letter" for the cover letter, or an application answer\'s id')
  .option("--guidance <text>", "note on what this regenerated piece should make sure to cover")
  .action(regeneratePieceCommand);

program
  .command("add-question")
  .description(
    "Add a brand-new question+answer to an already-generated application package, without " +
      "touching any existing piece. Does not change the run's workflow state."
  )
  .argument("<runId>")
  .argument("<question>", "the question text")
  .option("--max-chars <n>", "hard character limit for this answer (optional)")
  .option("--guidance <text>", "note on what this answer should make sure to cover")
  .action(addQuestionCommand);

program
  .command("review")
  .description("Print the vacancy report and application package for human review")
  .argument("<runId>")
  .action(reviewCommand);

program
  .command("accept")
  .description("Accept the application package (gate 2) -> PACKAGE_ACCEPTED")
  .argument("<runId>")
  .action(acceptCommand);

program
  .command("reject-package")
  .description("Reject the application package (gate 2) -> PACKAGE_REJECTED, re-run `generate` to retry")
  .argument("<runId>")
  .action(rejectPackageCommand);

program
  .command("confirm-submit")
  .description("Mark the application as submitted (you apply yourself — no browser automation) -> DONE")
  .argument("<runId>")
  .action(confirmSubmitCommand);

program
  .command("retry")
  .description(
    "Reset a run to CREATED (clearing any prior analysis/package artifacts) and re-analyze -> ANALYSIS_READY. " +
      "Works from any state except a run that's actively mid-step."
  )
  .argument("<runId>")
  .option("--source <text>", "replace the vacancy URL/raw text before re-analyzing (keeps the existing source if omitted)")
  .option("--type <type>", "url|raw_text (auto-detected from --source if omitted)")
  .action(retryCommand);

program
  .command("delete")
  .description("Permanently delete a run: DB rows and its data/runs/<runId>/ directory")
  .argument("<runId>")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(deleteRunCommand);

program
  .command("status")
  .description("Show one run's state and trace, or list all runs if no runId is given")
  .argument("[runId]")
  .action(statusCommand);

await program.parseAsync(process.argv);
