import { renderDashboard } from "./pages/dashboard.js";
import { renderRunDetail } from "./pages/runDetail.js";
import { renderAdminLanding } from "./pages/admin/landing.js";
import { renderAdminResumes } from "./pages/admin/resumes.js";
import { renderAdminAnswerExamples } from "./pages/admin/answerExamples.js";
import { renderAdminCoverLetters } from "./pages/admin/coverLetters.js";
import { renderAdminCandidateNotes } from "./pages/admin/candidateNotes.js";
import { renderAdminSettings } from "./pages/admin/settings.js";
import { renderAdminWorkbenches } from "./pages/admin/workbenches.js";
import { renderHelp } from "./pages/help.js";
import { initShell, setActiveRoute } from "./shell.js";

const ROUTES = [
  { pattern: /^#\/runs\/([^/]+)$/, routeKey: "dashboard", render: (m) => renderRunDetail(m[1]) },
  { pattern: /^#\/admin\/resumes$/, routeKey: "admin-resumes", render: renderAdminResumes },
  { pattern: /^#\/admin\/answer-examples$/, routeKey: "admin-answers", render: renderAdminAnswerExamples },
  { pattern: /^#\/admin\/cover-letters$/, routeKey: "admin-letters", render: renderAdminCoverLetters },
  { pattern: /^#\/admin\/candidate-notes$/, routeKey: "admin-notes", render: renderAdminCandidateNotes },
  { pattern: /^#\/admin\/settings$/, routeKey: "admin-settings", render: renderAdminSettings },
  { pattern: /^#\/admin\/workbenches$/, routeKey: "admin-workbenches", render: renderAdminWorkbenches },
  { pattern: /^#\/admin\/?$/, routeKey: "admin", render: renderAdminLanding },
  { pattern: /^#\/help$/, routeKey: "help", render: renderHelp },
];

function router() {
  const hash = location.hash || "#/";
  for (const route of ROUTES) {
    const match = route.pattern.exec(hash);
    if (match) {
      setActiveRoute(route.routeKey);
      route.render(match);
      return;
    }
  }
  setActiveRoute("dashboard");
  renderDashboard();
}

initShell();
window.addEventListener("hashchange", router);
router();
