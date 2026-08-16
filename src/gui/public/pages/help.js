import { app } from "../shared.js";

/** Static content, no API calls — a plain page like every other renderX() function, just with nothing to fetch. */
export async function renderHelp() {
  const kind = window.__WORKSPACE_KIND__;
  // Demo has zero access to /api/admin/* (hard-blocked server-side) — describing
  // a section it can't reach would just be confusing. A workbench has its own
  // resumes/examples/settings but isn't "admin" in any real sense to that user.
  const adminPanelCard =
    kind === "demo"
      ? ""
      : `<div class="card">
      <h2>${kind === "workbench" ? "Your workspace" : "Admin panel"}</h2>
      <p class="field-label">Fill these in before generating a package — the Writer grounds everything it
      writes in what's here, and produces a noticeably more generic result without it.</p>
      <dl class="kv">
        <dt>Resumes</dt><dd>Upload a PDF, or paste resume text directly — the one that best matches each vacancy is picked automatically.</dd>
        <dt>Answer examples</dt><dd>Past Q/A pairs you've written, used as grounding for new answers.</dd>
        <dt>Cover letters</dt><dd>Past cover letters, used for style/voice.</dd>
        <dt>Settings</dt><dd>Default word limits, cover-letter/humanize-style defaults, and the LLM
          provider/key (an alternative to setting them in <code>.env</code>).</dd>
      </dl>
    </div>`;

  app.innerHTML = `
    <div class="page-header"><h1>Help</h1></div>

    <div class="card">
      <h2>What this is</h2>
      <p>Paste a job vacancy, and this tool analyzes your fit, drafts a cover letter and
      answers to any application questions, and lets you review/edit everything before
      you actually apply yourself — nothing is ever submitted automatically.</p>
    </div>

    <div class="card">
      <h2>Workflow</h2>
      <ol class="plain">
        <li><strong>Paste a vacancy</strong> on the Dashboard — a URL or the raw job posting text — and click Analyze.
          If a URL fails to scrape (bot-check, login wall, JS-only page), paste the posting text instead.</li>
        <li><strong>Approve or reject</strong> the fit analysis on the run's page. Rejecting ends the run here.</li>
        <li><strong>Add the application's questions</strong> (if any) as manual questions, optionally toggle
          "include a cover letter" / "humanize style", then click <strong>Generate Package</strong>.</li>
        <li><strong>Review the package</strong> — cover letter, each answer, evidence checks, quality issues.
          Use "Regenerate this piece" on any single answer, or "+ Add another question" for one you missed,
          without regenerating everything else.</li>
        <li><strong>Accept or reject</strong> the package. Rejecting lets you Regenerate with new notes.</li>
        <li><strong>Copy the final text into the real application yourself</strong>, then click
          <strong>Mark as applied</strong> — this tool never fills out or submits a real form for you.</li>
      </ol>
    </div>

    ${adminPanelCard}

    <div class="card">
      <h2>Tips</h2>
      <ul class="plain">
        <li>Without any LLM key configured, everything runs on a deterministic stub — you can click through
          the whole workflow risk-free before spending anything on real API calls.</li>
        <li>"Humanize style" asks the Writer to avoid common AI-writing tells (neat three-item lists, uniform
          sentence rhythm, generic transitions) — worth trying if a draft reads as obviously AI-written.</li>
        <li>A run stuck on a scrape failure almost always just needs the vacancy text pasted directly instead
          of the URL — use "Edit source & retry analysis" at the bottom of the run's page.</li>
      </ul>
    </div>
  `;
}
