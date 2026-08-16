import {
  COVER_LETTER_PIECE_ID,
  STATE_BADGE,
  api,
  app,
  badge,
  escapeHtml,
  isAdvancedRunState,
  isTransientState,
  list,
  showError,
  showWarnings,
  uuid,
} from "../shared.js";
import { iconChevron } from "../icons.js";

/** A `<summary>` label with a chevron indicator — makes a `<details>` visually read as clickable rather than as plain text. */
function disclosureSummary(label) {
  return `<summary><span>${label}</span><span class="disclosure-chevron">${iconChevron()}</span></summary>`;
}

const RECOMMENDATION_BADGE = {
  APPLY: "ok",
  APPLY_WITH_CAUTION: "warn",
  REJECT: "bad",
};

const ACTIONS_BY_STATE = {
  ANALYSIS_READY: [
    { key: "approve", label: "Approve", cls: "primary" },
    { key: "reject", label: "Reject", cls: "danger" },
  ],
  ANALYSIS_APPROVED: [{ key: "generate", label: "Generate Package", cls: "primary" }],
  PACKAGE_READY: [
    { key: "accept", label: "Accept", cls: "primary" },
    { key: "reject-package", label: "Reject Package", cls: "danger" },
  ],
  PACKAGE_REJECTED: [{ key: "generate", label: "Regenerate", cls: "primary" }],
  PACKAGE_ACCEPTED: [{ key: "confirm-submit", label: "Mark as applied", cls: "primary" }],
};

const ACTION_WORKING_COPY = {
  generate: "Working… (multi-question forms can take several minutes)",
  retry: "Re-analyzing… (can take up to a minute)",
};

/** Human-readable labels for SalaryRangeSourceSchema's enum values (types/analysis.ts) — keep in sync. */
const SALARY_SOURCE_LABEL = {
  role_at_company: "This exact role at this company",
  seniority_at_company: "Similar seniority at this company",
  market_or_similar_companies: "Market-wide / similar companies",
  model_estimate: "Model estimate (no search data found)",
  unavailable: "Unavailable",
};

/** Absent on reports generated before this field existed — degrades to nothing rather than throwing. */
function renderSalaryInsight(salaryInsight) {
  if (!salaryInsight) return "";
  return `
    <dt>Estimated salary range</dt>
    <dd>
      ${escapeHtml(salaryInsight.range)}
      ${badge(SALARY_SOURCE_LABEL[salaryInsight.source] || salaryInsight.source, "neutral")}
      <br>${escapeHtml(salaryInsight.sourceNote || "")}
      ${salaryInsight.sourceUrls && salaryInsight.sourceUrls.length ? list(salaryInsight.sourceUrls) : ""}
    </dd>
  `;
}

function renderVacancyReport(report) {
  if (!report) return "";
  const { vacancy, fitAnalysis, companyResearch } = report;
  return `
    <details class="card" open>
      <summary><h2 style="display:inline">Vacancy Report</h2><span class="disclosure-chevron">${iconChevron()}</span></summary>
      <dl class="kv">
        <dt>Location</dt><dd>${escapeHtml(vacancy.location)}</dd>
        <dt>Employment</dt><dd>${escapeHtml(vacancy.employmentType)}</dd>
      </dl>
      <p>${escapeHtml(report.summary)}</p>
      <p><strong>${badge(report.recommendation, RECOMMENDATION_BADGE[report.recommendation])}</strong>
         ${escapeHtml(report.finalRecommendationNotes)}</p>
      <h3>Fit analysis — score ${fitAnalysis.fitScore}/100</h3>
      <dl class="kv">
        <dt>Strengths</dt><dd>${list(fitAnalysis.strengths)}</dd>
        <dt>Weaknesses</dt><dd>${list(fitAnalysis.weaknesses)}</dd>
        <dt>Missing skills</dt><dd>${list(fitAnalysis.missingSkills)}</dd>
      </dl>
      <p>${escapeHtml(fitAnalysis.strategicRecommendation)}</p>
      <h3>Company research</h3>
      <dl class="kv">
        <dt>Positive signals</dt><dd>${list(companyResearch.positiveSignals)}</dd>
        <dt>Risks</dt><dd>${list(companyResearch.risks)}</dd>
        <dt>Sources</dt><dd>${list(companyResearch.sources)}</dd>
        ${renderSalaryInsight(companyResearch.salaryInsight)}
      </dl>
    </details>
  `;
}

/**
 * One card per piece (cover letter or an answer) — shared by the cover letter
 * and every answer. `pieceId`/`runId`, when given (omitted for the legacy-shape
 * fallback view), add a per-piece "regenerate just this one" mini-form —
 * see regeneratePiece() on the orchestrator for what actually happens.
 */
function renderPieceCard(heading, text, opts) {
  const { maxCharacters, review, evidence, pieceId, runId, guidance, isCoverLetter, limits } = opts;
  const lengthBadge = maxCharacters
    ? badge(`${text.length}/${maxCharacters} characters`, text.length > maxCharacters ? "bad" : "ok")
    : "";
  const convergedBadge = review
    ? badge(review.converged ? "converged" : "needs review", review.converged ? "ok" : "warn")
    : "";
  const issuesList =
    review && review.issues.length
      ? `<ul class="plain">${review.issues
          .map((i) => `<li>${badge(i.severity, i.severity === "critical" ? "bad" : "warn")} ${escapeHtml(i.description)}</li>`)
          .join("")}</ul>`
      : "";
  const evidenceBlock =
    evidence && evidence.entries.length
      ? `<h4>Evidence check</h4>${evidence.entries
          .map(
            (e) => `
          <div class="evidence-entry">
            ${badge(e.supported ? "supported" : "unsupported", e.supported ? "ok" : "bad")}
            ${escapeHtml(e.claim)}
            ${e.evidence.length ? list(e.evidence) : ""}
          </div>`
          )
          .join("")}`
      : "";
  const lengthField = isCoverLetter
    ? `<div class="limits-row">
         <label>Min words <input type="number" class="piece-regenerate-min-words" min="1" placeholder="200" value="${limits?.coverLetterMinWords ?? ""}"></label>
         <label>Max words <input type="number" class="piece-regenerate-max-words" min="1" placeholder="450" value="${limits?.coverLetterMaxWords ?? ""}"></label>
       </div>`
    : `<label>Max characters (optional) <input type="number" class="piece-regenerate-max-chars" min="1" value="${maxCharacters ?? ""}"></label>`;
  const regenerateBlock =
    pieceId && runId
      ? `<details class="piece-regenerate">
           ${disclosureSummary("Regenerate this piece")}
           <textarea class="piece-regenerate-guidance guidance-textarea" placeholder="Optional notes for this regenerate">${escapeHtml(guidance || "")}</textarea>
           ${lengthField}
           <div class="actions">
             <button type="button" class="piece-regenerate-btn" data-piece-id="${escapeHtml(pieceId)}" data-run-id="${escapeHtml(runId)}" data-is-cover-letter="${isCoverLetter ? "true" : "false"}">Regenerate</button>
           </div>
         </details>`
      : "";

  return `
    <div class="piece-card">
      <details class="content-disclosure" open>
        <summary><h3 style="display:inline">${escapeHtml(heading)}</h3><span class="disclosure-chevron">${iconChevron()}</span></summary>
        <pre class="letter">${escapeHtml(text)}</pre>
        <div class="actions">${lengthBadge}${convergedBadge}</div>
        ${issuesList}
        ${evidenceBlock}
      </details>
      ${regenerateBlock}
    </div>
  `;
}

function renderApplicationPackage(files, runId, guidanceById, limits) {
  if (!files || Object.keys(files).length === 0) return "";

  const resumeEdits = files["resume-edits.md"];
  const coverLetter = files["cover-letter.md"] ?? "";
  let answers = [];
  let finalReview = null;
  let evidenceMap = null;
  try {
    answers = files["application-answers.json"] ? JSON.parse(files["application-answers.json"]) : [];
  } catch {
    /* leave [] if malformed */
  }
  try {
    finalReview = files["final-review.json"] ? JSON.parse(files["final-review.json"]) : null;
  } catch {
    /* leave null if malformed */
  }
  try {
    evidenceMap = files["evidence-mapping.json"] ? JSON.parse(files["evidence-mapping.json"]) : null;
  } catch {
    /* leave null if malformed */
  }

  // Runs generated before this version's multi-piece schema shape have no
  // `pieceReviews` array on their final-review.json — rendering those with
  // the new per-piece logic would throw. Fall back to a plain, honest view
  // instead of crashing on old data.
  const isLegacyShape = finalReview && !Array.isArray(finalReview.pieceReviews);
  if (isLegacyShape) {
    return `
      <div class="card">
        <h2>Application Package</h2>
        <p class="warning-banner">This run's package was generated by an older version of this tool — showing raw files instead of the structured view.</p>
        ${resumeEdits ? `<h3>Resume selection</h3><pre class="letter">${escapeHtml(resumeEdits)}</pre>` : ""}
        ${coverLetter ? `<h3>Cover letter</h3><pre class="letter">${escapeHtml(coverLetter)}</pre>` : ""}
        ${files["application-answers.md"] ? `<h3>Application answers</h3><pre class="letter">${escapeHtml(files["application-answers.md"])}</pre>` : ""}
      </div>
    `;
  }

  const reviewByPieceId = new Map((finalReview?.pieceReviews ?? []).map((r) => [r.pieceId, r]));
  const evidenceByPieceId = new Map((evidenceMap?.pieceResults ?? []).map((r) => [r.pieceId, r]));

  // Empty means the cover letter was toggled off for this generate() call —
  // nothing to show, not a missing/broken piece.
  const coverLetterCard = coverLetter
    ? renderPieceCard("Cover letter", coverLetter, {
        review: reviewByPieceId.get(COVER_LETTER_PIECE_ID),
        evidence: evidenceByPieceId.get(COVER_LETTER_PIECE_ID),
        pieceId: COVER_LETTER_PIECE_ID,
        runId,
        guidance: guidanceById?.[COVER_LETTER_PIECE_ID],
        isCoverLetter: true,
        limits,
      })
    : "";
  const answerCards = answers
    .map((a) =>
      renderPieceCard(a.question, a.answer, {
        maxCharacters: a.maxCharacters,
        review: reviewByPieceId.get(a.id),
        evidence: evidenceByPieceId.get(a.id),
        pieceId: a.id,
        runId,
        guidance: guidanceById?.[a.id],
      })
    )
    .join("");

  return `
    <div class="card">
      <h2>Application Package</h2>
      ${
        resumeEdits
          ? `<div class="piece-card">
               <details class="content-disclosure" open>
                 <summary><h3 style="display:inline">Resume selection</h3><span class="disclosure-chevron">${iconChevron()}</span></summary>
                 <pre class="letter">${escapeHtml(resumeEdits)}</pre>
               </details>
             </div>`
          : ""
      }
      ${coverLetterCard}
      ${answerCards}
      ${renderAddQuestionForm(runId)}
    </div>
  `;
}

/**
 * Persistent mini-form, always available once a package exists — unlike the
 * generate-form's manual-question rows (which only take effect on the next
 * full Generate/Regenerate), this submits immediately via `addQuestion` and
 * only that one new answer gets generated.
 */
function renderAddQuestionForm(runId) {
  return `
    <details class="piece-regenerate">
      ${disclosureSummary("+ Add another question")}
      <input type="text" id="add-question-text" placeholder="Question text">
      <input type="number" id="add-question-max-chars" min="1" placeholder="Max chars (optional)">
      <textarea id="add-question-guidance" class="guidance-textarea" placeholder="Notes for this answer (optional)"></textarea>
      <div class="actions">
        <button type="button" class="primary" id="add-question-btn" data-run-id="${escapeHtml(runId)}">Add question</button>
      </div>
    </details>
  `;
}

function manualQuestionRowHtml(q) {
  const id = (q && q.id) || uuid();
  const question = (q && q.question) || "";
  const maxCharacters = q && q.maxCharacters != null ? q.maxCharacters : "";
  const guidance = (q && q.guidance) || "";
  return `
    <div class="manual-question-row" data-id="${escapeHtml(id)}">
      <input type="hidden" class="mq-id" value="${escapeHtml(id)}">
      <input type="text" class="mq-question" placeholder="Question text" value="${escapeHtml(question)}">
      <input type="number" class="mq-max-chars" min="1" placeholder="Max chars (optional)" value="${escapeHtml(maxCharacters)}">
      <textarea class="mq-guidance guidance-textarea" placeholder="Notes for this answer (optional)">${escapeHtml(guidance)}</textarea>
      <button type="button" class="danger mq-remove">Remove</button>
    </div>`;
}

function renderManualQuestionsForm(manualQuestions) {
  const rows = (manualQuestions ?? []).map(manualQuestionRowHtml).join("");
  return `
    <div class="manual-questions">
      <span class="field-label">Application questions (paste in the questions from the real form — there's no auto-detection in this version)</span>
      <div id="manual-questions-list">${rows}</div>
      <div class="actions"><button type="button" id="add-manual-question">+ Add question</button></div>
    </div>
  `;
}

function renderTrace(trace) {
  if (!trace || trace.length === 0) return "";
  const rows = trace
    .map((e) => {
      const label =
        e.eventType === "state_transition"
          ? `${escapeHtml(e.fromState)} → ${escapeHtml(e.toState)}`
          : e.eventType === "error"
            ? // Two distinct shapes land here: Tracer.recordError() stores
              // {message} directly; a failed agent call (recordAgentCall with
              // response.status === "error") stores the whole AgentResponse,
              // whose message is nested one level deeper at responseJson.error.message.
              escapeHtml(
                (e.agentName ? `${e.agentName}: ` : "") +
                  ((e.responseJson && (e.responseJson.message || (e.responseJson.error && e.responseJson.error.message))) || "")
              )
            : escapeHtml(e.agentName || e.toolName || "");
      return `<tr class="trace-row">
        <td>#${e.seq}</td>
        <td>${escapeHtml(e.eventType)}</td>
        <td>${label}</td>
        <td>${e.durationMs != null ? e.durationMs + "ms" : ""}</td>
        <td>${e.estimatedCostUsd != null ? "$" + e.estimatedCostUsd.toFixed(5) : ""}</td>
      </tr>`;
    })
    .join("");

  const totalDurationMs = trace.reduce((sum, e) => sum + (e.durationMs || 0), 0);
  const totalCost = trace.reduce((sum, e) => sum + (e.estimatedCostUsd || 0), 0);

  return `
    <details class="card">
      <summary><h2 style="display:inline">Execution trace (${trace.length} events)</h2><span class="disclosure-chevron">${iconChevron()}</span></summary>
      <div class="overflow-x"><table>
        <thead><tr><th>#</th><th>Type</th><th>Detail</th><th>Duration</th><th>Est. cost</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="3" style="text-align:right"><strong>Total</strong></td>
          <td><strong>${totalDurationMs}ms</strong></td>
          <td><strong>$${totalCost.toFixed(5)}</strong></td>
        </tr></tfoot>
      </table></div>
    </details>
  `;
}

/**
 * Deliberately its own card, always last, visually separated from the main
 * gate-progression action bar above — Retry/Delete are never mistaken for
 * forward workflow actions. Shown for any run not currently mid-step.
 *
 * Auto-expanded (and re-worded) when the run FAILED from a URL source — the
 * most common cause is the page not being scrapeable at all (bot check,
 * login wall, JS-only shell), and orchestrator.ts's looksLikeFailedExtraction
 * check already says so directly in run.errorMessage. Pasting the vacancy
 * text here and retrying is the actual fix, so it shouldn't be hidden behind
 * an unopened <details> the user has to think to click.
 */
function renderRunManagement(run) {
  const failedFromUrl = run.state === "FAILED" && run.vacancySourceType === "url";
  const hint = failedFromUrl
    ? "Analysis failed, likely because the page couldn't be scraped (bot check, login wall, or JS-only " +
      "content). Paste the vacancy text below instead of the URL, then retry."
    : isAdvancedRunState(run.state)
      ? "Editing and retrying discards this run's existing vacancy report and application package, AND " +
        "its accept/apply progress and iteration counters — it resets all the way back to a fresh analysis."
      : "Editing and retrying discards this run's existing vacancy report and application package.";

  return `
    <div class="card">
      <h2>Run management</h2>
      <details class="piece-regenerate"${failedFromUrl ? " open" : ""}>
        ${disclosureSummary("Edit source &amp; retry analysis")}
        <p class="field-label">${escapeHtml(hint)}</p>
        <textarea id="retry-source" placeholder="Vacancy URL or raw text">${escapeHtml(run.vacancySource)}</textarea>
        <span class="field-label">Country/location for salary research (optional) — overrides the vacancy's own listed location</span>
        <input type="text" id="retry-salary-location" placeholder="e.g. Germany, or Poland" value="${escapeHtml(run.salaryLocationOverride || "")}">
        <div class="actions">
          <button type="button" class="primary" id="retry-btn">Retry analysis</button>
        </div>
      </details>
      <div class="actions">
        <button type="button" class="danger" id="delete-btn">Delete run</button>
      </div>
    </div>
  `;
}

/**
 * `formOverride` ({manualQuestions, limits}), when given, wins over whatever's
 * persisted in `generationSettings` — used by runAction() to restore the
 * whole generate-form (manual-question rows AND cover-letter limits) the user
 * was still editing when an unrelated action triggered this full re-render,
 * so in-progress input is never silently lost.
 */
export async function renderRunDetail(runId, formOverride) {
  app.innerHTML = `<div class="loading">Loading run…</div>`;
  let data;
  try {
    data = await api(`/api/runs/${runId}`);
  } catch (err) {
    app.innerHTML = `<a class="back-link" href="#/">← Dashboard</a><div class="error-banner">${escapeHtml(err.message)}</div>`;
    return;
  }

  const { run, vacancyReport, applicationPackageFiles, trace, generationSettings, appSettingsDefaults } = data;
  const actions = ACTIONS_BY_STATE[run.state] || [];
  const hasGenerate = actions.some((a) => a.key === "generate");
  const manualQuestions = formOverride?.manualQuestions ?? generationSettings?.manualQuestions;
  const limits = formOverride?.limits ?? generationSettings?.limits ?? appSettingsDefaults?.limits;
  const includeCoverLetter =
    formOverride?.includeCoverLetter ??
    generationSettings?.includeCoverLetter ??
    appSettingsDefaults?.includeCoverLetter ??
    true;
  const guidanceById = formOverride?.guidanceById ?? generationSettings?.guidanceById ?? {};
  const humanizeStyle =
    formOverride?.humanizeStyle ?? generationSettings?.humanizeStyle ?? appSettingsDefaults?.humanizeStyle ?? false;
  const avoidOverfitting =
    formOverride?.avoidOverfitting ??
    generationSettings?.avoidOverfitting ??
    appSettingsDefaults?.avoidOverfitting ??
    false;

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/">Dashboard</a> / ${escapeHtml(run.vacancyTitle || "Untitled vacancy")}</div>
    <div class="page-header">
      <h1>${escapeHtml(run.vacancyTitle || "Untitled vacancy")} ${run.companyName ? "@ " + escapeHtml(run.companyName) : ""}</h1>
      <div>${badge(run.state, STATE_BADGE[run.state] || "neutral")}</div>
    </div>
    ${run.errorMessage ? `<div class="error-banner">${escapeHtml(run.errorMessage)}</div>` : ""}
    ${
      actions.length
        ? `<div class="card"><h2>Actions</h2>
            ${
              hasGenerate
                ? `<div class="limits-form">
                    <h3>Application questions</h3>
                    ${renderManualQuestionsForm(manualQuestions)}
                  </div>
                  <div class="limits-form">
                    <label><input type="checkbox" id="humanize-style" ${humanizeStyle ? "checked" : ""}> Write in a more human, less "AI-sounding" style (applies to the cover letter AND every answer)</label>
                    <label><input type="checkbox" id="avoid-overfitting" ${avoidOverfitting ? "checked" : ""}> Don't over-tailor to this posting's exact wording — write with natural, understated confidence instead</label>
                  </div>
                  <div class="limits-form">
                    <label><input type="checkbox" id="include-cover-letter" ${includeCoverLetter ? "checked" : ""}> Include a cover letter</label>
                    <span class="field-label">Cover letter notes (optional — anything you want the letter to make sure to mention)</span>
                    <textarea id="cover-letter-guidance" class="guidance-textarea" placeholder="e.g. mention my open-source work">${escapeHtml(guidanceById[COVER_LETTER_PIECE_ID] || "")}</textarea>
                  </div>
                  <div class="limits-form">
                    <span class="field-label">Cover letter limits (optional — blank uses the configured defaults)</span>
                    <div class="limits-row">
                      <label>Min words <input type="number" id="limit-min-words" min="1" placeholder="200" value="${limits?.coverLetterMinWords ?? ""}"></label>
                      <label>Max words <input type="number" id="limit-max-words" min="1" placeholder="450" value="${limits?.coverLetterMaxWords ?? ""}"></label>
                      <label>Fallback answer max words (used only for questions without their own max-chars limit) <input type="number" id="limit-answer-words" min="1" placeholder="150" value="${limits?.answerMaxWords ?? ""}"></label>
                    </div>
                  </div>`
                : ""
            }
            <div class="actions" id="action-bar">
            ${actions.map((a) => `<button class="${a.cls}" data-action="${a.key}">${escapeHtml(a.label)}</button>`).join("")}
          </div></div>`
        : ""
    }
    ${renderVacancyReport(vacancyReport)}
    ${renderApplicationPackage(applicationPackageFiles, runId, guidanceById, limits)}
    ${renderTrace(trace)}
    ${!isTransientState(run.state) ? renderRunManagement(run) : ""}
  `;

  document.querySelectorAll("#action-bar button").forEach((btn) => {
    btn.addEventListener("click", () => runAction(runId, btn.dataset.action, btn));
  });

  const addBtn = document.getElementById("add-manual-question");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      document.getElementById("manual-questions-list").insertAdjacentHTML("beforeend", manualQuestionRowHtml(null));
    });
  }
  const manualQuestionsList = document.getElementById("manual-questions-list");
  if (manualQuestionsList) {
    manualQuestionsList.addEventListener("click", (e) => {
      if (e.target.classList.contains("mq-remove")) {
        e.target.closest(".manual-question-row").remove();
      }
    });
  }

  const retryBtn = document.getElementById("retry-btn");
  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      const confirmMessage = isAdvancedRunState(run.state)
        ? "Retry analysis? This discards any existing vacancy report and application package, AND this " +
          "run's accept/apply progress and iteration counters — it resets all the way back to a fresh analysis."
        : "Retry analysis? This discards any existing vacancy report and application package for this run.";
      if (!window.confirm(confirmMessage)) {
        return;
      }
      const source = document.getElementById("retry-source").value.trim();
      const salaryLocation = document.getElementById("retry-salary-location").value.trim();
      retryBtn.disabled = true;
      const originalText = retryBtn.textContent;
      retryBtn.textContent = ACTION_WORKING_COPY.retry;
      try {
        const body = {};
        if (source && source !== run.vacancySource) body.source = source;
        if (salaryLocation !== (run.salaryLocationOverride || "")) {
          body.salaryLocationOverride = salaryLocation || null;
        }
        const { warnings } = await api(`/api/runs/${runId}/retry`, {
          method: "POST",
          body: Object.keys(body).length ? JSON.stringify(body) : undefined,
        });
        await renderRunDetail(runId);
        showWarnings(warnings);
      } catch (err) {
        showError(err.message);
        retryBtn.disabled = false;
        retryBtn.textContent = originalText;
      }
    });
  }

  const deleteBtn = document.getElementById("delete-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!window.confirm("Permanently delete this run? This cannot be undone.")) return;
      deleteBtn.disabled = true;
      try {
        await api(`/api/runs/${runId}`, { method: "DELETE" });
        location.hash = "#/";
      } catch (err) {
        showError(err.message);
        deleteBtn.disabled = false;
      }
    });
  }

  document.querySelectorAll(".piece-regenerate-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pieceId = btn.dataset.pieceId;
      const block = btn.closest(".piece-regenerate");
      const guidance = block.querySelector(".piece-regenerate-guidance").value.trim();
      const readNumber = (selector) => {
        const el = block.querySelector(selector);
        const value = el ? Number.parseInt(el.value, 10) : NaN;
        return Number.isFinite(value) && value > 0 ? value : undefined;
      };
      const body = { guidance: guidance || undefined };
      if (btn.dataset.isCoverLetter === "true") {
        body.coverLetterMinWords = readNumber(".piece-regenerate-min-words");
        body.coverLetterMaxWords = readNumber(".piece-regenerate-max-words");
      } else {
        body.maxCharacters = readNumber(".piece-regenerate-max-chars");
      }
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "Regenerating…";
      try {
        const { warnings } = await api(`/api/runs/${runId}/pieces/${encodeURIComponent(pieceId)}/regenerate`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        await renderRunDetail(runId);
        showWarnings(warnings);
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  const addQuestionBtn = document.getElementById("add-question-btn");
  if (addQuestionBtn) {
    addQuestionBtn.addEventListener("click", async () => {
      const question = document.getElementById("add-question-text").value.trim();
      if (!question) return;
      const maxCharsRaw = document.getElementById("add-question-max-chars").value;
      const maxCharacters = Number.parseInt(maxCharsRaw, 10);
      const guidance = document.getElementById("add-question-guidance").value.trim();
      addQuestionBtn.disabled = true;
      const originalText = addQuestionBtn.textContent;
      addQuestionBtn.textContent = "Adding…";
      try {
        const { warnings } = await api(`/api/runs/${runId}/pieces`, {
          method: "POST",
          body: JSON.stringify({
            question,
            maxCharacters: Number.isFinite(maxCharacters) && maxCharacters > 0 ? maxCharacters : undefined,
            guidance: guidance || undefined,
          }),
        });
        await renderRunDetail(runId);
        showWarnings(warnings);
      } catch (err) {
        showError(err.message);
        addQuestionBtn.disabled = false;
        addQuestionBtn.textContent = originalText;
      }
    });
  }
}

function readWriterLimitsForm() {
  const readField = (id) => {
    const el = document.getElementById(id);
    const value = el ? Number.parseInt(el.value, 10) : NaN;
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return {
    coverLetterMinWords: readField("limit-min-words"),
    coverLetterMaxWords: readField("limit-max-words"),
    answerMaxWords: readField("limit-answer-words"),
  };
}

function readManualQuestions() {
  return Array.from(document.querySelectorAll(".manual-question-row")).flatMap((row) => {
    const question = row.querySelector(".mq-question").value.trim();
    if (!question) return [];
    const id = row.querySelector(".mq-id").value;
    const maxCharsRaw = row.querySelector(".mq-max-chars").value;
    const maxCharacters = Number.parseInt(maxCharsRaw, 10);
    const guidance = row.querySelector(".mq-guidance").value.trim();
    return [
      {
        id,
        question,
        maxCharacters: Number.isFinite(maxCharacters) && maxCharacters > 0 ? maxCharacters : undefined,
        guidance: guidance || undefined,
      },
    ];
  });
}

/**
 * Like readManualQuestions(), but keeps rows with blank/in-progress question
 * text instead of dropping them — used to snapshot the form before an action
 * OTHER than generate() re-renders the whole page (generate() persists
 * whatever was typed itself; nothing else does), so a still-being-typed
 * question isn't silently wiped out from under the user.
 */
function captureManualQuestionRows() {
  return Array.from(document.querySelectorAll(".manual-question-row")).map((row) => ({
    id: row.querySelector(".mq-id").value,
    question: row.querySelector(".mq-question").value,
    maxCharacters: row.querySelector(".mq-max-chars").value || undefined,
    guidance: row.querySelector(".mq-guidance").value || undefined,
  }));
}

function readIncludeCoverLetter() {
  const el = document.getElementById("include-cover-letter");
  return el ? el.checked : true;
}

function readHumanizeStyle() {
  const el = document.getElementById("humanize-style");
  return el ? el.checked : false;
}

function readAvoidOverfitting() {
  const el = document.getElementById("avoid-overfitting");
  return el ? el.checked : false;
}

/** Cover-letter notes textarea, keyed like the server expects. */
function readGuidanceById() {
  const result = {};
  const coverLetterEl = document.getElementById("cover-letter-guidance");
  const coverLetterGuidance = coverLetterEl ? coverLetterEl.value.trim() : "";
  if (coverLetterGuidance) result[COVER_LETTER_PIECE_ID] = coverLetterGuidance;
  return result;
}

function readGenerateBody() {
  return {
    ...readWriterLimitsForm(),
    manualQuestions: readManualQuestions(),
    includeCoverLetter: readIncludeCoverLetter(),
    guidanceById: readGuidanceById(),
    humanizeStyle: readHumanizeStyle(),
    avoidOverfitting: readAvoidOverfitting(),
  };
}

/**
 * Snapshot of the whole generate-form (manual questions + limits + cover-letter
 * toggle/notes), taken right before an action that isn't generate() itself
 * re-renders the page. generate()'s own submission already persists whatever
 * was typed, so its post-render fetch already reflects it; any other action
 * would otherwise silently discard in-progress editing across the re-render.
 */
function captureUnsavedFormState() {
  const bar = document.getElementById("action-bar");
  if (!bar) return undefined;
  return {
    manualQuestions: captureManualQuestionRows(),
    limits: readWriterLimitsForm(),
    includeCoverLetter: readIncludeCoverLetter(),
    guidanceById: readGuidanceById(),
    humanizeStyle: readHumanizeStyle(),
    avoidOverfitting: readAvoidOverfitting(),
  };
}

async function runAction(runId, actionKey, btn) {
  const bar = document.getElementById("action-bar");
  const body = actionKey === "generate" ? readGenerateBody() : undefined;
  const unsavedFormState = actionKey === "generate" ? undefined : captureUnsavedFormState();
  bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const originalText = btn.textContent;
  btn.textContent = ACTION_WORKING_COPY[actionKey] || "Working…";

  try {
    const { warnings } = await api(`/api/runs/${runId}/${actionKey}`, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    await renderRunDetail(runId, unsavedFormState);
    showWarnings(warnings);
  } catch (err) {
    showError(err.message);
    bar.querySelectorAll("button").forEach((b) => (b.disabled = false));
    btn.textContent = originalText;
  }
}
