// Renders the persistent left-sidebar chrome once, and owns the theme
// toggle. Route highlighting is handled separately by setActiveRoute() so
// the sidebar itself never needs to re-render on navigation.
import {
  iconAdmin,
  iconAnswers,
  iconCoverLetter,
  iconDashboard,
  iconHelp,
  iconMoon,
  iconNotes,
  iconResume,
  iconSettings,
  iconSun,
  iconWorkbenches,
} from "./icons.js";

const NAV_ITEMS = [
  { route: "dashboard", href: "#/", icon: iconDashboard, label: "Dashboard" },
];
const HELP_ITEM = { route: "help", href: "#/help", icon: iconHelp, label: "Help" };
// Doubles as both the section heading AND the actual link to the Admin
// landing page — rendered as its own <a>, not folded into ADMIN_ITEMS below,
// so `setActiveRoute()` has something with `data-route="admin"` to highlight
// when you're on #/admin itself. Label is kind-aware: a friend using their own
// workbench sees "My workspace" (their own resumes/examples/settings), and a
// demo visitor sees "Preview" — neither should see the literal word "Admin",
// which would misleadingly suggest they have admin rights.
function adminHubLabel() {
  if (window.__WORKSPACE_KIND__ === "workbench") return "My workspace";
  if (window.__WORKSPACE_KIND__ === "demo") return "Preview";
  return "Admin";
}
const ADMIN_ITEMS = [
  { route: "admin-resumes", href: "#/admin/resumes", icon: iconResume, label: "Resumes" },
  { route: "admin-answers", href: "#/admin/answer-examples", icon: iconAnswers, label: "Answer examples" },
  { route: "admin-letters", href: "#/admin/cover-letters", icon: iconCoverLetter, label: "Cover letters" },
  { route: "admin-notes", href: "#/admin/candidate-notes", icon: iconNotes, label: "Candidate notes" },
  { route: "admin-settings", href: "#/admin/settings", icon: iconSettings, label: "Settings" },
];
// "Workbenches" management is meaningful only in the actual admin workspace —
// a demo visitor or a workbench's own operator has no use for (and no access
// to) the "manage other workbenches" API, so it's excluded from ADMIN_ITEMS
// above and appended separately, only when window.__WORKSPACE_KIND__ === "admin".
const WORKBENCHES_ITEM = {
  route: "admin-workbenches",
  href: "#/admin/workbenches",
  icon: iconWorkbenches,
  label: "Workbenches",
};

// window.__WORKSPACE_KIND__ is injected server-side into index.html per
// request (undefined in legacy/single-instance mode, where it's always the
// "admin" instance anyway — same effect as an explicit "admin").
function isAdminWorkspace() {
  return !window.__WORKSPACE_KIND__ || window.__WORKSPACE_KIND__ === "admin";
}

function navLinkHtml(item, extraClass = "") {
  return `<a href="${item.href}" class="sidebar-nav-item${extraClass ? ` ${extraClass}` : ""}" data-route="${item.route}"><span class="sidebar-icon">${item.icon()}</span>${item.label}</a>`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.innerHTML = theme === "dark" ? iconSun() : iconMoon();
}

export function initShell() {
  const sidebar = document.getElementById("sidebar");
  // Demo gets the same read-only preview of Resumes/Answer examples/Cover
  // letters/Candidate notes/Settings as a workbench would see of its own data
  // (see each admin/*.js page for the read-only rendering) — "Workbenches"
  // management stays admin-only regardless, since isAdminWorkspace() is false
  // for demo, same as for a workbench.
  const adminHub = { route: "admin", href: "#/admin", icon: iconAdmin, label: adminHubLabel() };
  const adminItems = isAdminWorkspace() ? [...ADMIN_ITEMS, WORKBENCHES_ITEM] : ADMIN_ITEMS;
  const adminSectionHtml = `${navLinkHtml(adminHub, "sidebar-section-label")}${adminItems.map((item) => navLinkHtml(item)).join("")}`;

  // Legacy/single-instance mode (window.__WORKSPACE_BASE__ === "") has no
  // session/login at all — nothing to sign out of, so this stays hidden there.
  const showSignOut = Boolean(window.__WORKSPACE_BASE__);
  const signOutHtml = showSignOut
    ? `<button type="button" class="sidebar-nav-item sidebar-footer-link sidebar-signout" id="sign-out-btn">Sign out</button>`
    : "";

  sidebar.innerHTML = `
    <a href="#/" class="brand">◆ RoleCase</a>
    <div class="sidebar-nav">
      ${NAV_ITEMS.map((item) => navLinkHtml(item)).join("")}
      ${adminSectionHtml}
    </div>
    ${navLinkHtml(HELP_ITEM, "sidebar-footer-link")}
    ${signOutHtml}
    <button type="button" class="theme-toggle" id="theme-toggle" title="Toggle light/dark theme"></button>
  `;

  if (showSignOut) {
    document.getElementById("sign-out-btn").addEventListener("click", async () => {
      const base = window.__WORKSPACE_BASE__;
      try {
        await fetch(`${base}/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      } catch {
        // Best-effort — redirect regardless, the worst case is a still-valid
        // session cookie that expires naturally on its own TTL.
      }
      window.location.href = `${base}/login`;
    });
  }

  const stored = localStorage.getItem("theme");
  const theme = stored || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(theme);

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    applyTheme(next);
  });
}

/** Called by the router after every navigation — highlights the current section without re-rendering the sidebar. */
export function setActiveRoute(routeKey) {
  document.querySelectorAll(".sidebar-nav-item").forEach((el) => {
    const isAdminSub = routeKey.startsWith("admin") && el.dataset.route === "admin";
    el.classList.toggle("active", el.dataset.route === routeKey || isAdminSub);
  });
}
