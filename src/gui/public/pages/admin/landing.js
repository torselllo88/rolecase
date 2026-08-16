import { api, app, escapeHtml } from "../../shared.js";
import { iconAnswers, iconCoverLetter, iconNotes, iconResume, iconSettings, iconWorkbenches } from "../../icons.js";

const CARDS = [
  { href: "#/admin/resumes", icon: iconResume, title: "Resumes", countKey: "resumes", endpoint: "/api/admin/resumes" },
  {
    href: "#/admin/answer-examples",
    icon: iconAnswers,
    title: "Answer examples",
    countKey: "entries",
    endpoint: "/api/admin/answer-examples",
  },
  {
    href: "#/admin/cover-letters",
    icon: iconCoverLetter,
    title: "Cover letter examples",
    countKey: "entries",
    endpoint: "/api/admin/cover-letters",
  },
  {
    href: "#/admin/candidate-notes",
    icon: iconNotes,
    title: "Candidate notes",
    countKey: "entries",
    endpoint: "/api/admin/candidate-notes",
  },
  { href: "#/admin/settings", icon: iconSettings, title: "Settings", countKey: null, endpoint: null },
];
// Only the actual admin workspace can manage OTHER workbenches — /api/admin/workbenches
// 404s under a workbench's own instance and is hard-blocked under demo.
const WORKBENCHES_CARD = {
  href: "#/admin/workbenches",
  icon: iconWorkbenches,
  title: "Workbenches",
  countKey: "workbenches",
  endpoint: "/api/admin/workbenches",
};

export async function renderAdminLanding() {
  app.innerHTML = `<div class="loading">Loading admin…</div>`;

  const isAdminWorkspace = !window.__WORKSPACE_KIND__ || window.__WORKSPACE_KIND__ === "admin";
  const cards = isAdminWorkspace ? [...CARDS, WORKBENCHES_CARD] : CARDS;

  const counts = await Promise.all(
    cards.map(async (c) => {
      if (!c.endpoint) return null;
      try {
        const data = await api(c.endpoint);
        return data[c.countKey]?.length ?? 0;
      } catch {
        return null;
      }
    })
  );

  app.innerHTML = `
    <div class="page-header"><h1>Admin</h1></div>
    <div class="admin-card-grid">
      ${cards.map(
        (c, i) => `
        <a class="card admin-card" href="${c.href}">
          <div class="admin-card-icon">${c.icon()}</div>
          <h3>${escapeHtml(c.title)}</h3>
          <p class="field-label">${counts[i] === null ? "Configure" : `${counts[i]} item${counts[i] === 1 ? "" : "s"}`}</p>
        </a>`
      ).join("")}
    </div>
  `;
}
