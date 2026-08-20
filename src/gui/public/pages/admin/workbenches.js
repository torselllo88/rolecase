import { api, app, escapeHtml, formatDate, showError } from "../../shared.js";

function rowHtml(w) {
  const link = `${window.location.origin}/workbench/${encodeURIComponent(w.slug)}`;
  return `
    <div class="admin-list-row" data-slug="${escapeHtml(w.slug)}">
      <div style="min-width:0">
        <strong>${escapeHtml(w.displayName)}</strong>
        <div class="field-label" style="overflow-wrap:anywhere">
          <a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a>
          <button type="button" class="wb-copy-link" data-link="${escapeHtml(link)}" title="Copy link">Copy</button>
          · created ${escapeHtml(formatDate(w.createdAt))}
        </div>
      </div>
      <div class="actions">
        <button type="button" class="wb-edit" data-slug="${escapeHtml(w.slug)}">Edit</button>
        <button type="button" class="wb-reset" data-slug="${escapeHtml(w.slug)}">Reset data</button>
        <button type="button" class="danger wb-delete" data-slug="${escapeHtml(w.slug)}">Delete</button>
      </div>
    </div>`;
}

function editFormHtml(w) {
  return `
    <div class="admin-list-row admin-edit-form" data-slug="${escapeHtml(w.slug)}">
      <div style="flex:1">
        <label>Display name <input type="text" class="wb-edit-name" value="${escapeHtml(w.displayName)}"></label>
        <label>New password <input type="password" class="wb-edit-password" placeholder="Leave blank to keep the current password" autocomplete="off"></label>
      </div>
      <div class="actions">
        <button type="button" class="primary wb-edit-save" data-slug="${escapeHtml(w.slug)}">Save</button>
        <button type="button" class="wb-edit-cancel">Cancel</button>
      </div>
    </div>`;
}

export async function renderAdminWorkbenches() {
  app.innerHTML = `<div class="loading">Loading workbenches…</div>`;
  let workbenches;
  try {
    ({ workbenches } = await api("/api/admin/workbenches"));
  } catch (err) {
    app.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    return;
  }

  const workspacesEnabled = window.__WORKSPACES_ENABLED__;

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/admin">Admin</a> / Workbenches</div>
    <div class="page-header"><h1>Workbenches</h1></div>
    <p class="field-label">
      Each workbench is a fully separate, password-gated instance for a friend — its own runs, resumes,
      answer examples, and cover letters. Leave its own LLM key unset in its Settings page to use yours instead.
    </p>
    ${
      workspacesEnabled
        ? ""
        : `<div class="warning-banner">
             Multi-workspace mode is off — set <code>ADMIN_PASSWORD</code> in <code>.env</code> and restart the server
             before creating a workbench, or its link will never resolve. Rename/reset/delete of an existing workbench
             still work either way.
           </div>`
    }
    <div class="card settings-section">
      <h2>New workbench</h2>
      <label>Slug (used in its URL — lowercase letters, numbers, hyphens)
        <input type="text" id="wb-new-slug" placeholder="e.g. alex" ${workspacesEnabled ? "" : "disabled"}>
      </label>
      <label>Display name <input type="text" id="wb-new-name" placeholder="e.g. Alex" ${workspacesEnabled ? "" : "disabled"}></label>
      <label>Password <input type="password" id="wb-new-password" autocomplete="off" ${workspacesEnabled ? "" : "disabled"}></label>
      <div class="actions">
        <button type="button" class="primary" id="wb-new-save" ${workspacesEnabled ? "" : "disabled"}>Create</button>
      </div>
      <div id="wb-new-feedback"></div>
    </div>
    <div class="card" id="workbenches-list">
      ${workbenches.length === 0 ? emptyStateHtml() : workbenches.map(rowHtml).join("")}
    </div>
  `;

  const list = document.getElementById("workbenches-list");

  function emptyStateHtml() {
    return `<div class="empty-state"><p>No workbenches yet — create one above.</p></div>`;
  }

  function removeEmptyState() {
    list.querySelector(".empty-state")?.remove();
  }

  const newSaveBtn = document.getElementById("wb-new-save");
  newSaveBtn.addEventListener("click", async () => {
    const slugInput = document.getElementById("wb-new-slug");
    const nameInput = document.getElementById("wb-new-name");
    const passwordInput = document.getElementById("wb-new-password");
    const feedback = document.getElementById("wb-new-feedback");
    const slug = slugInput.value.trim().toLowerCase();
    const displayName = nameInput.value.trim() || slug;
    const password = passwordInput.value;
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) {
      feedback.innerHTML = `<div class="error-banner">Slug must be 1-40 lowercase letters, numbers, or hyphens.</div>`;
      return;
    }
    if (!password) {
      feedback.innerHTML = `<div class="error-banner">A password is required.</div>`;
      return;
    }
    newSaveBtn.disabled = true;
    try {
      const created = await api("/api/admin/workbenches", {
        method: "POST",
        body: JSON.stringify({ slug, displayName, password }),
      });
      feedback.innerHTML = "";
      slugInput.value = "";
      nameInput.value = "";
      passwordInput.value = "";
      removeEmptyState();
      workbenches = [...workbenches, created];
      list.insertAdjacentHTML("afterbegin", rowHtml(created));
      wireRow(list.querySelector(`[data-slug="${created.slug}"]`));
    } catch (err) {
      feedback.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    } finally {
      newSaveBtn.disabled = false;
    }
  });

  function wireRow(el) {
    const slug = el.dataset.slug;
    const current = workbenches.find((w) => w.slug === slug);

    el.querySelector(".wb-copy-link").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const link = btn.dataset.link;
      try {
        await navigator.clipboard.writeText(link);
        const original = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      } catch {
        window.prompt("Copy this link:", link);
      }
    });

    el.querySelector(".wb-edit").addEventListener("click", () => {
      el.outerHTML = editFormHtml(current);
      wireForm(list.querySelector(`.admin-edit-form[data-slug="${slug}"]`));
    });

    el.querySelector(".wb-reset").addEventListener("click", async () => {
      const btn = el.querySelector(".wb-reset");
      if (!window.confirm(`Reset "${current.displayName}"? This permanently deletes all its runs, resumes, and examples — its login and password stay the same.`)) return;
      btn.disabled = true;
      const originalLabel = btn.textContent;
      try {
        await api(`/api/admin/workbenches/${encodeURIComponent(slug)}/reset`, { method: "POST" });
        btn.textContent = "Reset ✓";
        setTimeout(() => {
          btn.textContent = originalLabel;
        }, 1500);
      } catch (err) {
        showError(err.message);
      } finally {
        btn.disabled = false;
      }
    });

    el.querySelector(".wb-delete").addEventListener("click", async () => {
      const btn = el.querySelector(".wb-delete");
      if (!window.confirm(`Delete "${current.displayName}" entirely? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/workbenches/${encodeURIComponent(slug)}`, { method: "DELETE" });
        workbenches = workbenches.filter((w) => w.slug !== slug);
        el.remove();
        if (list.children.length === 0) list.insertAdjacentHTML("beforeend", emptyStateHtml());
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
      }
    });
  }

  function wireForm(formEl) {
    const slug = formEl.dataset.slug;
    formEl.querySelector(".wb-edit-cancel").addEventListener("click", () => {
      const current = workbenches.find((w) => w.slug === slug);
      formEl.outerHTML = rowHtml(current);
      wireRow(list.querySelector(`[data-slug="${slug}"]`));
    });
    const saveBtn = formEl.querySelector(".wb-edit-save");
    saveBtn.addEventListener("click", async () => {
      const displayName = formEl.querySelector(".wb-edit-name").value.trim();
      const password = formEl.querySelector(".wb-edit-password").value;
      if (!displayName) {
        showError("Display name cannot be empty.");
        return;
      }
      saveBtn.disabled = true;
      try {
        const body = { displayName };
        if (password) body.password = password;
        await api(`/api/admin/workbenches/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify(body) });
        const updated = { ...workbenches.find((w) => w.slug === slug), displayName };
        workbenches = workbenches.map((w) => (w.slug === slug ? updated : w));
        formEl.outerHTML = rowHtml(updated);
        wireRow(list.querySelector(`[data-slug="${slug}"]`));
      } catch (err) {
        showError(err.message);
        saveBtn.disabled = false;
      }
    });
  }

  list.querySelectorAll(".admin-list-row").forEach(wireRow);
}
