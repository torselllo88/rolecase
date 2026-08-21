import { STATE_BADGE, api, app, badge, escapeHtml, formatDate, isTransientState, showError } from "../shared.js";

const RECOMMENDATION_BADGE = {
  APPLY: "ok",
  APPLY_WITH_CAUTION: "warn",
  REJECT: "bad",
};

// Demo-only quick-fill — deliberately has a couple of stretch requirements
// (Go, deeper Kubernetes/platform ownership) the seeded sample resume/notes
// don't fully cover, so a hands-off demo visitor still sees a real fit
// assessment with actual reasoning, not a trivial 100/100.
const SAMPLE_VACANCY_TEXT = `Senior Backend Engineer — Meridian Pay

Meridian Pay is a Berlin-based fintech platform providing payment infrastructure
for mid-size B2B marketplaces across Europe. We're growing our platform team and
looking for a Senior Backend Engineer to help us scale our transaction processing
systems.

Location: Berlin (hybrid, 2 days/week in office) or remote within the EU.

What you'll do:
- Design and build backend services for our core payments and settlement platform.
- Own service boundaries and data models for transaction processing, reconciliation, and reporting.
- Work with event-driven architecture (Kafka) to process payment state changes reliably at scale.
- Improve reliability and observability of production systems handling millions of daily requests.
- Contribute to our platform's move toward greater Kubernetes-based operational ownership.
- Mentor mid-level engineers and participate in architecture reviews.

What we're looking for:
- 5+ years of backend engineering experience, ideally in fintech, payments, or another
  transactional/regulated domain.
- Strong experience with Node.js/TypeScript and PostgreSQL.
- Experience with Kafka or another event-streaming system in production.
- Solid understanding of AWS (ECS/EKS, RDS, S3, IAM).
- Comfortable owning services end-to-end, including production incidents.
- Nice to have: hands-on Kubernetes platform engineering experience; familiarity with Go.

Compensation: EUR 85k-110k base, plus equity, depending on experience.

We're a 40-person team, mostly engineers, with a flat structure and no dedicated
platform/SRE team yet — senior backend engineers are expected to also own a good
chunk of operational and infrastructure decisions.`;

export async function renderDashboard() {
  app.innerHTML = `<div class="loading">Loading runs…</div>`;
  let runs;
  try {
    ({ runs } = await api("/api/runs"));
  } catch (err) {
    app.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    return;
  }

  const rows = runs
    .map(
      (r) => `
      <tr class="run-row" data-id="${escapeHtml(r.id)}">
        <td>${escapeHtml(r.vacancyTitle || "—")}</td>
        <td>${escapeHtml(r.companyName || "—")}</td>
        <td>${badge(r.state, STATE_BADGE[r.state] || "neutral")}</td>
        <td>${r.recommendation ? badge(r.recommendation, RECOMMENDATION_BADGE[r.recommendation]) : "—"}</td>
        <td>${escapeHtml(formatDate(r.createdAt))}</td>
        <td>${
          isTransientState(r.state)
            ? ""
            : `<button type="button" class="danger list-delete" data-id="${escapeHtml(r.id)}">Delete</button>`
        }</td>
      </tr>`
    )
    .join("");

  const isDemo = window.__WORKSPACE_KIND__ === "demo";

  app.innerHTML = `
    <div class="page-header"><h1>Dashboard</h1></div>
    ${
      isDemo
        ? `<div class="warning-banner">
             You're in the public demo — LLM calls are stubbed (no real AI, no cost), and demo applications
             are automatically deleted after a while. Nothing here is private to you beyond this browser session.
           </div>`
        : ""
    }
    <div class="card">
      <h2>New application</h2>
      <form id="new-run-form" class="new-run">
        <span class="field-label">Vacancy URL or raw text</span>
        <textarea id="new-run-source" placeholder="https://... or paste the vacancy text" required></textarea>
        ${
          isDemo
            ? `<button type="button" id="fill-sample-vacancy">Try a sample vacancy</button>`
            : ""
        }
        <span class="field-label">Country/location for salary research (optional) — overrides the vacancy's own listed location; useful for a remote role</span>
        <input type="text" id="new-run-salary-location" placeholder="e.g. Germany, or Poland">
        ${
          isDemo
            ? `<span class="field-label">Optionally paste your own resume instead of the sample candidate (used for this application only — never saved or shown to anyone else)</span>
               <textarea id="new-run-resume-text" placeholder="Leave blank to use the seeded sample resume (Daniel Mercer)"></textarea>`
            : ""
        }
        <div class="actions">
          <button type="submit" class="primary">Analyze</button>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Your applications</h2>
      ${
        runs.length === 0
          ? `<div class="empty-state"><p>No applications yet.</p><p class="field-label">Paste a vacancy above to start.</p></div>`
          : `<div class="overflow-x"><table>
              <thead><tr><th>Vacancy</th><th>Company</th><th>State</th><th>Recommendation</th><th>Created</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>`
      }
    </div>
  `;

  document.querySelectorAll("tr.run-row").forEach((row) => {
    row.addEventListener("click", () => {
      location.hash = `#/runs/${row.dataset.id}`;
    });
  });

  document.querySelectorAll(".list-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!window.confirm("Permanently delete this run? This cannot be undone.")) return;
      btn.disabled = true;
      try {
        await api(`/api/runs/${btn.dataset.id}`, { method: "DELETE" });
        await renderDashboard();
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
      }
    });
  });

  document.getElementById("fill-sample-vacancy")?.addEventListener("click", () => {
    document.getElementById("new-run-source").value = SAMPLE_VACANCY_TEXT;
  });

  document.getElementById("new-run-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = document.getElementById("new-run-source").value.trim();
    if (!source) return;
    const resumeText = isDemo ? document.getElementById("new-run-resume-text")?.value.trim() : "";
    const salaryLocationOverride = document.getElementById("new-run-salary-location").value.trim();
    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Analyzing… (can take up to a minute)";
    try {
      const body = { source };
      if (resumeText) body.resumeText = resumeText;
      if (salaryLocationOverride) body.salaryLocationOverride = salaryLocationOverride;
      const { run } = await api("/api/runs", { method: "POST", body: JSON.stringify(body) });
      location.hash = `#/runs/${run.id}`;
    } catch (err) {
      showError(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Analyze";
    }
  });
}
