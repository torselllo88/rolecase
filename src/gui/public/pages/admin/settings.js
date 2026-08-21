import { api, app, demoPreviewBannerHtml, escapeHtml, isDemoWorkspace } from "../../shared.js";

/**
 * Demo never has real settings (forced stub, no keys) — rather than showing
 * an all-blank page that undersells the feature, this fills in illustrative
 * example values so a visitor can see the shape of per-agent overrides, agent
 * instructions, etc. None of it is real, and the whole page renders inside a
 * <fieldset disabled> below, so it can never actually be edited or saved.
 */
const DEMO_EXAMPLE_SETTINGS = {
  llmProvider: "openrouter",
  openRouterApiKeyConfigured: true,
  openRouterModel: "anthropic/claude-sonnet-4.5",
  openRouterModelByConsumer: { CRITIC: "anthropic/claude-haiku-latest" },
  azureApiKeyConfigured: false,
  azureEndpoint: "",
  azureApiVersion: "",
  azureDeployment: "",
  braveSearchApiKeyConfigured: true,
  defaultIncludeCoverLetter: true,
  defaultHumanizeStyle: true,
  defaultAvoidOverfitting: false,
  defaultLimits: { coverLetterMinWords: 200, coverLetterMaxWords: 450, answerMaxWords: 150 },
  maxWriterCriticIterations: 4,
  agentInstructions: { WRITER: "Keep tone confident but understated — no superlatives." },
};

// Mirrors src/types/agent.ts's AgentName values — the id suffix (agent-key.toLowerCase())
// is what the textarea's DOM id and the request body key are both keyed by.
const AGENT_LABELS = [
  { key: "VACANCY_ANALYZER", label: "Vacancy analysis & fit scoring" },
  { key: "COMPANY_RESEARCH", label: "Company & salary research" },
  { key: "RESUME_SELECTOR", label: "Resume selection" },
  { key: "WRITER", label: "Writer (cover letter & answers)" },
  { key: "CRITIC", label: "Critic (quality review)" },
  { key: "EVIDENCE_CHECKER", label: "Evidence checking" },
];

// ModelConsumer = AgentName | "RESUME_LIBRARY" — one more entry than AGENT_LABELS above.
const MODEL_CONSUMER_LABELS = [...AGENT_LABELS, { key: "RESUME_LIBRARY", label: "Resume text cleanup" }];

/** Always-visible key input, not gated behind a "Change" button — type a new value and hit the page's Save button; leaving it blank keeps whatever's already configured. */
function keyStatusField(idPrefix, label, configured) {
  return `
    <div class="key-status-row">
      <div class="key-status">
        <span class="field-label">${escapeHtml(label)}</span>
        <span class="badge ${configured ? "ok" : "neutral"}">${configured ? "✓ configured" : "not set"}</span>
      </div>
      <input type="password" id="${idPrefix}-input" class="key-input" placeholder="${configured ? "Leave blank to keep current key" : "Paste key"}" autocomplete="off">
    </div>`;
}

/** `savedMessage`, when given, is shown in the feedback slot right after this render — used to carry a "✓ Saved" confirmation across the full re-render the save handler triggers (a plain post-save `feedback.innerHTML` write gets wiped out immediately by that re-render otherwise). */
export async function renderAdminSettings(savedMessage) {
  const isDemo = isDemoWorkspace();
  let settings;
  if (isDemo) {
    settings = DEMO_EXAMPLE_SETTINGS;
  } else {
    app.innerHTML = `<div class="loading">Loading settings…</div>`;
    try {
      settings = await api("/api/admin/settings");
    } catch (err) {
      app.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      return;
    }
  }

  const provider = settings.llmProvider ?? "";
  const includeCoverLetter = settings.defaultIncludeCoverLetter ?? true;
  const humanizeStyle = settings.defaultHumanizeStyle ?? false;
  const avoidOverfitting = settings.defaultAvoidOverfitting ?? false;
  const limits = settings.defaultLimits ?? {};
  const agentInstructions = settings.agentInstructions ?? {};
  const openRouterModelByConsumer = settings.openRouterModelByConsumer ?? {};
  const maxWriterCriticIterations = settings.maxWriterCriticIterations ?? "";

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/admin">${isDemo ? "Preview" : "Admin"}</a> / Settings</div>
    <div class="page-header"><h1>Settings</h1></div>
    ${isDemo ? demoPreviewBannerHtml() : ""}
    <fieldset ${isDemo ? "disabled" : ""} style="border:0;padding:0;margin:0">

    <div class="card settings-section">
      <h2>Generation defaults</h2>
      <p class="field-label">Applied to every new run unless overridden per-run in the generate form.</p>
      <label><input type="checkbox" id="s-include-cover-letter" ${includeCoverLetter ? "checked" : ""}> Include a cover letter by default</label>
      <label><input type="checkbox" id="s-humanize-style" ${humanizeStyle ? "checked" : ""}> Write in a more human, less "AI-sounding" style by default</label>
      <label><input type="checkbox" id="s-avoid-overfitting" ${avoidOverfitting ? "checked" : ""}> Don't over-tailor to each posting's exact wording by default</label>
      <div class="limits-row">
        <label>Cover letter min words <input type="number" id="s-min-words" min="1" placeholder="200" value="${limits.coverLetterMinWords ?? ""}"></label>
        <label>Cover letter max words <input type="number" id="s-max-words" min="1" placeholder="450" value="${limits.coverLetterMaxWords ?? ""}"></label>
        <label>Answer fallback max words <input type="number" id="s-answer-words" min="1" placeholder="150" value="${limits.answerMaxWords ?? ""}"></label>
      </div>
      <label>Max Writer/Critic refinement iterations (default 4 — lower to cap cost, at the expense of polish)
        <input type="number" id="s-max-iterations" min="1" max="10" placeholder="4" value="${maxWriterCriticIterations}">
      </label>
    </div>

    <div class="card settings-section">
      <h2>LLM provider</h2>
      <p class="field-label">Leave on "Auto-detect" to use whatever's configured in .env; pick one explicitly to override it here instead.</p>
      <label>Provider
        <select id="s-provider">
          <option value="" ${provider === "" ? "selected" : ""}>Auto-detect (.env)</option>
          <option value="openrouter" ${provider === "openrouter" ? "selected" : ""}>OpenRouter</option>
          <option value="azure" ${provider === "azure" ? "selected" : ""}>Azure OpenAI</option>
        </select>
      </label>

      <div id="s-openrouter-fields" class="provider-fields" ${provider === "azure" ? "hidden" : ""}>
        <h3>OpenRouter</h3>
        ${keyStatusField("s-openrouter-key", "API key", settings.openRouterApiKeyConfigured)}
        <label>Default model <input type="text" id="s-openrouter-model" placeholder="e.g. anthropic/claude-sonnet-4.5" value="${escapeHtml(settings.openRouterModel || "")}"></label>
        <details>
          <summary><h4 style="display:inline">Per-agent model overrides (advanced)</h4></summary>
          <p class="field-label">Optional — overrides the default model above for one specific agent, for THIS workspace only. Blank uses the default model. Useful for capping cost (e.g. pointing Critic at something cheaper than what the admin's own .env may pin it to).</p>
          ${MODEL_CONSUMER_LABELS.map(
            ({ key, label }) => `
            <label>${escapeHtml(label)}
              <input type="text" id="s-model-${key}" placeholder="e.g. anthropic/claude-haiku-latest" value="${escapeHtml(openRouterModelByConsumer[key] || "")}">
            </label>`
          ).join("")}
        </details>
      </div>

      <div id="s-azure-fields" class="provider-fields" ${provider === "openrouter" || provider === "" ? "hidden" : ""}>
        <h3>Azure OpenAI</h3>
        ${keyStatusField("s-azure-key", "API key", settings.azureApiKeyConfigured)}
        <label>Endpoint <input type="text" id="s-azure-endpoint" placeholder="https://your-resource.openai.azure.com" value="${escapeHtml(settings.azureEndpoint || "")}"></label>
        <label>API version <input type="text" id="s-azure-api-version" placeholder="2024-08-01-preview" value="${escapeHtml(settings.azureApiVersion || "")}"></label>
        <label>Deployment <input type="text" id="s-azure-deployment" placeholder="your-deployment-name" value="${escapeHtml(settings.azureDeployment || "")}"></label>
      </div>

    </div>

    <div class="card settings-section">
      <h2>Company &amp; salary research</h2>
      <p class="field-label">A separate credential from the LLM key above — used only by Company Research's web search. Without it, company/salary research always falls back to a deterministic stub, even with an LLM key configured.</p>
      ${keyStatusField("s-brave-key", "Brave Search API key", settings.braveSearchApiKeyConfigured)}
    </div>

    <div class="card settings-section">
      <details>
        <summary><h2 style="display:inline">Agent instructions (advanced)</h2></summary>
        <p class="field-label">Appended to the end of that agent's internal instructions — keep it short and behavioral (tone/scope), not a request to change its output format; the app still expects the same structured response either way.</p>
        ${AGENT_LABELS.map(
          ({ key, label }) => `
          <label>${escapeHtml(label)}
            <textarea id="s-agent-${key}" class="guidance-textarea" placeholder="Optional extra instruction for this agent">${escapeHtml(agentInstructions[key] || "")}</textarea>
          </label>`
        ).join("")}
      </details>
    </div>

    <div class="card settings-section">
      <div class="actions">
        <button type="button" class="primary" id="s-save-btn">Save</button>
      </div>
      <div id="s-save-feedback"></div>
    </div>
    </fieldset>
  `;

  if (savedMessage) {
    document.getElementById("s-save-feedback").innerHTML = `<div class="success-banner">${escapeHtml(savedMessage)}</div>`;
  }

  document.getElementById("s-provider").addEventListener("change", (e) => {
    document.getElementById("s-openrouter-fields").hidden = e.target.value === "azure";
    document.getElementById("s-azure-fields").hidden = e.target.value !== "azure";
  });

  document.getElementById("s-save-btn").addEventListener("click", async () => {
    const btn = document.getElementById("s-save-btn");
    btn.disabled = true;
    const feedback = document.getElementById("s-save-feedback");
    feedback.innerHTML = "";

    // null (not undefined/omitted) for a blank field — JSON.stringify drops
    // `undefined` keys entirely, which would make "field left blank" and
    // "field never mentioned" indistinguishable on the wire; the server
    // treats an explicit null as "clear this specific limit back to the
    // env/hardcoded default" (see parsePartialWriterLimits in gui/server.ts).
    const numberOrNull = (id) => {
      const value = Number.parseInt(document.getElementById(id).value, 10);
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    const body = {
      defaultIncludeCoverLetter: document.getElementById("s-include-cover-letter").checked,
      defaultHumanizeStyle: document.getElementById("s-humanize-style").checked,
      defaultAvoidOverfitting: document.getElementById("s-avoid-overfitting").checked,
      defaultLimits: {
        coverLetterMinWords: numberOrNull("s-min-words"),
        coverLetterMaxWords: numberOrNull("s-max-words"),
        answerMaxWords: numberOrNull("s-answer-words"),
      },
      maxWriterCriticIterations: numberOrNull("s-max-iterations"),
      llmProvider: document.getElementById("s-provider").value || null,
      openRouterModel: document.getElementById("s-openrouter-model").value.trim() || null,
      openRouterModelByConsumer: Object.fromEntries(
        MODEL_CONSUMER_LABELS.map(({ key }) => [key, document.getElementById(`s-model-${key}`).value.trim()])
      ),
      azureEndpoint: document.getElementById("s-azure-endpoint").value.trim() || null,
      azureApiVersion: document.getElementById("s-azure-api-version").value.trim() || null,
      azureDeployment: document.getElementById("s-azure-deployment").value.trim() || null,
      agentInstructions: Object.fromEntries(
        AGENT_LABELS.map(({ key }) => [key, document.getElementById(`s-agent-${key}`).value.trim()])
      ),
    };
    // Only ever submit a key typed into a section that's actually VISIBLE
    // right now — a key typed while left on "Auto-detect" still saves
    // (auto-detect picks OpenRouter/Azure whenever one is configured,
    // regardless of the explicit provider choice — see createLlmProvider()).
    // Switching the dropdown away from a provider hides its whole section,
    // which is what stops a key typed for a provider you've since switched
    // away from being silently saved — blank fields (the common case) never
    // touch the persisted key either way, per the parseAdminSettingsUpdate
    // convention (only a non-empty value overwrites it).
    const openRouterVisible = !document.getElementById("s-openrouter-fields").hidden;
    const openRouterKeyInput = document.getElementById("s-openrouter-key-input");
    if (openRouterVisible && openRouterKeyInput.value.trim()) {
      body.openRouterApiKey = openRouterKeyInput.value.trim();
    }
    const azureVisible = !document.getElementById("s-azure-fields").hidden;
    const azureKeyInput = document.getElementById("s-azure-key-input");
    if (azureVisible && azureKeyInput.value.trim()) {
      body.azureApiKey = azureKeyInput.value.trim();
    }
    // No section-visibility gate here (unlike OpenRouter/Azure above) — Brave
    // Search isn't tied to the provider dropdown.
    const braveKeyInput = document.getElementById("s-brave-key-input");
    if (braveKeyInput.value.trim()) {
      body.braveSearchApiKey = braveKeyInput.value.trim();
    }

    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(body) });
      await renderAdminSettings("✓ Saved");
    } catch (err) {
      feedback.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}
