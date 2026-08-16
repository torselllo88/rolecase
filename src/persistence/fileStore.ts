import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { currentDataDir } from "../config/workspaceContext.js";
import type { VacancyReport } from "../types/analysis.js";
import type { ApplicationPackage } from "../types/application.js";
import type { GenerationSettings } from "../types/generationSettings.js";

function runDir(runId: string): string {
  return path.join(currentDataDir(), "runs", runId);
}

function applicationPackageDir(runId: string): string {
  return path.join(runDir(runId), "application-package");
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function renderVacancyReportMarkdown(report: VacancyReport): string {
  const { vacancy, fitAnalysis, companyResearch } = report;
  const atsLines = fitAnalysis.atsKeywordCoverage
    .map((k) => `- [${k.covered ? "x" : " "}] ${k.keyword}`)
    .join("\n");

  return `# Vacancy Report: ${vacancy.title} at ${vacancy.company}

## Summary

${report.summary}

## Recommendation: ${report.recommendation}

${report.finalRecommendationNotes}

## Fit Analysis

- Fit score: ${fitAnalysis.fitScore}/100
- Strengths: ${fitAnalysis.strengths.join(", ") || "none"}
- Weaknesses: ${fitAnalysis.weaknesses.join(", ") || "none"}
- Missing skills: ${fitAnalysis.missingSkills.join(", ") || "none"}
- Suggested resume hint: ${fitAnalysis.suggestedResumeHint}
- Strategic recommendation: ${fitAnalysis.strategicRecommendation}

### ATS Keyword Coverage

${atsLines}

## Company Research

- Positive signals: ${companyResearch.positiveSignals.join(", ") || "none"}
- Risks: ${companyResearch.risks.join(", ") || "none"}
- Sources: ${companyResearch.sources.join(", ") || "none"}
`;
}

/**
 * The only place that formats structured data into Markdown. Agents and tools
 * return structured data only — keeping "structured outputs over hidden
 * reasoning" intact all the way to this boundary.
 */
export const fileStore = {
  runDir,

  writeVacancyReport(runId: string, report: VacancyReport): void {
    const dir = runDir(runId);
    writeFile(path.join(dir, "vacancy-report.json"), JSON.stringify(report, null, 2));
    writeFile(path.join(dir, "vacancy-report.md"), renderVacancyReportMarkdown(report));
  },

  readVacancyReport(runId: string): VacancyReport | undefined {
    const file = path.join(runDir(runId), "vacancy-report.json");
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as VacancyReport;
  },

  writeApplicationPackage(runId: string, pkg: ApplicationPackage): void {
    const dir = applicationPackageDir(runId);

    // Actively removed (not just skipped) when empty — a regenerate that
    // toggles the cover letter off must not leave a PREVIOUS generate()'s
    // cover-letter.md sitting on disk as stale, misleadingly-still-readable
    // content.
    if (pkg.coverLetter) {
      writeFile(path.join(dir, "cover-letter.md"), pkg.coverLetter);
    } else {
      fs.rmSync(path.join(dir, "cover-letter.md"), { force: true });
    }
    writeFile(
      path.join(dir, "application-answers.md"),
      pkg.applicationAnswers.map((qa) => `**Q: ${qa.question}**\n\n${qa.answer}\n`).join("\n")
    );
    // Structured mirror of the same answers — the .md file above is for
    // humans; regeneratePiece()/addQuestion() read this one back for
    // per-answer edits instead of re-parsing the Markdown.
    writeFile(
      path.join(dir, "application-answers.json"),
      JSON.stringify(pkg.applicationAnswers, null, 2)
    );
    writeFile(
      path.join(dir, "resume-edits.md"),
      `# Resume Selection\n\nSelected resume: ${pkg.resumeSelection.selectedResumeId}\n\n` +
        `## Reasoning\n\n${pkg.resumeSelection.reasoning}\n\n## Suggested modifications\n\n` +
        pkg.resumeSelection.suggestedModifications.map((m) => `- ${m}`).join("\n")
    );
    // Structured mirror of the same selection — resume-edits.md above is
    // human-readable prose; regeneratePiece() needs the actual
    // selectedResumeId back to re-fetch that resume's text for grounding.
    writeFile(path.join(dir, "resume-selection.json"), JSON.stringify(pkg.resumeSelection, null, 2));
    if (pkg.recruiterNotes) {
      writeFile(path.join(dir, "recruiter-notes.md"), pkg.recruiterNotes);
    }
    writeFile(path.join(dir, "evidence-mapping.json"), JSON.stringify(pkg.evidenceMap, null, 2));
    writeFile(path.join(dir, "final-review.json"), JSON.stringify(pkg.finalReview, null, 2));

    // Manifest snapshot, written last, so detectHandEdits() can tell a future
    // regenerate whether a human touched these files in between.
    writeFile(
      path.join(dir, ".manifest.json"),
      JSON.stringify(this.hashApplicationPackageFiles(runId), null, 2)
    );
  },

  readApplicationPackageFiles(runId: string): Record<string, string> {
    const dir = applicationPackageDir(runId);
    if (!fs.existsSync(dir)) return {};
    const result: Record<string, string> = {};
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith(".")) continue;
      result[file] = fs.readFileSync(path.join(dir, file), "utf-8");
    }
    return result;
  },

  hashApplicationPackageFiles(runId: string): Record<string, string> {
    const dir = applicationPackageDir(runId);
    if (!fs.existsSync(dir)) return {};
    const result: Record<string, string> = {};
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith(".")) continue;
      result[file] = hashContent(fs.readFileSync(path.join(dir, file), "utf-8"));
    }
    return result;
  },

  /**
   * Returns filenames whose content differs from the manifest recorded at the
   * last writeApplicationPackage() call — a human likely hand-edited them.
   * Warning-only signal for the regenerate path; no merge/diff UI.
   */
  detectHandEdits(runId: string): string[] {
    const manifestFile = path.join(applicationPackageDir(runId), ".manifest.json");
    if (!fs.existsSync(manifestFile)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as Record<string, string>;
    const current = this.hashApplicationPackageFiles(runId);

    return Object.entries(manifest)
      .filter(([file, hash]) => current[file] && current[file] !== hash)
      .map(([file]) => file);
  },

  writeGenerationSettings(runId: string, settings: GenerationSettings): void {
    writeFile(path.join(runDir(runId), "generation-settings.json"), JSON.stringify(settings, null, 2));
  },

  readGenerationSettings(runId: string): GenerationSettings | undefined {
    const file = path.join(runDir(runId), "generation-settings.json");
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as GenerationSettings;
  },

  /**
   * Demo-only: a one-off pasted resume for this run alone — an input like
   * vacancySource, not a downstream analysis artifact, so clearDownstreamArtifacts()
   * deliberately leaves it alone (a retry should keep reusing the same pasted resume).
   */
  writeAdhocResumeText(runId: string, text: string): void {
    writeFile(path.join(runDir(runId), "adhoc-resume.txt"), text);
  },

  readAdhocResumeText(runId: string): string | undefined {
    const file = path.join(runDir(runId), "adhoc-resume.txt");
    if (!fs.existsSync(file)) return undefined;
    return fs.readFileSync(file, "utf-8");
  },

  /**
   * Removes everything downstream of the vacancy source itself, so a retried
   * run can't end up presenting a mix of fresh analysis and stale artifacts
   * (a generation-settings.json or application-package/ from a *previous*
   * vacancy text/URL for this same run id).
   */
  clearDownstreamArtifacts(runId: string): void {
    const dir = runDir(runId);
    for (const name of ["vacancy-report.json", "vacancy-report.md", "generation-settings.json"]) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
    fs.rmSync(applicationPackageDir(runId), { recursive: true, force: true });
  },

  deleteRunDir(runId: string): void {
    fs.rmSync(runDir(runId), { recursive: true, force: true });
  },
};
