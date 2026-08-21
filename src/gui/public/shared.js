// Small helpers shared by every page module — deliberately plain functions,
// no framework: this whole frontend is served as-is with no build step.

/** Mirrors writerCriticLoop.ts's exported COVER_LETTER_PIECE_ID — this file is plain unbundled JS and can't import it. Keep both in sync. */
export const COVER_LETTER_PIECE_ID = "cover_letter";

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export function badge(text, cls) {
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function api(path, options) {
  // window.__WORKSPACE_BASE__ is injected server-side into index.html per request
  // (empty string in legacy/single-instance mode, so this is a no-op there).
  const base = window.__WORKSPACE_BASE__ ?? "";
  const res = await fetch(base + path, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  if (res.status === 401 && base) {
    // Session expired/missing — legacy mode never gets here (no login page
    // exists there, and nothing ever 401s), so `base` being non-empty is what
    // tells us there's actually somewhere to redirect to.
    window.location.href = `${base}/login`;
    throw new Error("Your session has expired — redirecting to sign in.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

export function list(items) {
  if (!items || items.length === 0) return "<em>none</em>";
  return `<ul class="plain">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

export const STATE_BADGE = {
  CREATED: "neutral",
  ANALYZING: "info",
  ANALYSIS_READY: "warn",
  REJECTED: "bad",
  ANALYSIS_APPROVED: "info",
  GENERATING_PACKAGE: "info",
  PACKAGE_READY: "warn",
  PACKAGE_REJECTED: "warn",
  PACKAGE_ACCEPTED: "info",
  DONE: "ok",
  FAILED: "bad",
};

/** Mirrors orchestrator.ts's TRANSIENT_STATES — retry/delete are refused server-side for these too. */
const TRANSIENT_STATES = new Set(["ANALYZING", "GENERATING_PACKAGE"]);
export function isTransientState(state) {
  return TRANSIENT_STATES.has(state);
}

/** States where a run also has accept/apply progress and iteration counters to lose on retry. */
const ADVANCED_STATES = new Set(["PACKAGE_ACCEPTED", "DONE"]);
export function isAdvancedRunState(state) {
  return ADVANCED_STATES.has(state);
}

/** The single <main id="app"> mount point every page renders into. */
export const app = document.getElementById("app");

export function showError(message) {
  app.insertAdjacentHTML("afterbegin", `<div class="error-banner">${escapeHtml(message)}</div>`);
}

export function isDemoWorkspace() {
  return window.__WORKSPACE_KIND__ === "demo";
}

/** Shown at the top of every admin/* page's read-only demo rendering — same banner everywhere so it's instantly recognizable as "this one's just a preview." */
export function demoPreviewBannerHtml() {
  return `<div class="warning-banner">Read-only preview in the public demo — this shows what a real workspace looks like, but nothing here can be changed.</div>`;
}

export function showWarnings(warnings) {
  if (warnings && warnings.length) {
    app.insertAdjacentHTML("afterbegin", `<div class="warning-banner">${warnings.map(escapeHtml).join("<br>")}</div>`);
  }
}
