import { api, app, demoPreviewBannerHtml, escapeHtml, isDemoWorkspace, showError } from "../../shared.js";

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function entryRowHtml(entry) {
  if (!entry.editable) {
    return `
      <div class="admin-list-row" data-id="${escapeHtml(entry.id)}">
        <div>
          <span class="badge neutral">legacy file</span>
          <p class="field-label">${escapeHtml(truncate(entry.text, 200))}</p>
        </div>
        <div class="actions">
          <button type="button" class="danger letter-delete" data-id="${escapeHtml(entry.id)}">Delete</button>
        </div>
      </div>`;
  }
  return `
    <div class="admin-list-row" data-id="${escapeHtml(entry.id)}">
      <p>${escapeHtml(truncate(entry.text, 240))}</p>
      <div class="actions">
        <button type="button" class="letter-edit" data-id="${escapeHtml(entry.id)}">Edit</button>
        <button type="button" class="danger letter-delete" data-id="${escapeHtml(entry.id)}">Delete</button>
      </div>
    </div>`;
}

function readOnlyRowHtml(entry) {
  return `
    <div class="admin-list-row" data-id="${escapeHtml(entry.id)}">
      <p>${escapeHtml(truncate(entry.text, 240))}</p>
    </div>`;
}

function entryFormHtml(id, text) {
  return `
    <div class="admin-list-row admin-edit-form" data-id="${escapeHtml(id || "")}">
      <div style="flex:1">
        <textarea class="letter-text guidance-textarea" placeholder="Cover letter example text" style="min-height:120px">${escapeHtml(text || "")}</textarea>
      </div>
      <div class="actions">
        <button type="button" class="primary letter-save" data-id="${escapeHtml(id || "")}">Save</button>
        <button type="button" class="letter-cancel">Cancel</button>
      </div>
    </div>`;
}

/** Same "patch the DOM, never re-fetch-and-re-render the whole page" discipline as answerExamples.js — see its own doc comment for why. */
export async function renderAdminCoverLetters() {
  app.innerHTML = `<div class="loading">Loading cover letter examples…</div>`;
  let entries;
  try {
    ({ entries } = await api("/api/admin/cover-letters"));
  } catch (err) {
    app.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    return;
  }

  if (isDemoWorkspace()) {
    app.innerHTML = `
      <div class="breadcrumb"><a href="#/admin">Preview</a> / Cover letter examples</div>
      <div class="page-header"><h1>Cover letter examples</h1></div>
      ${demoPreviewBannerHtml()}
      <div class="card">
        ${entries.length === 0 ? `<div class="empty-state"><p>No examples yet.</p></div>` : entries.map(readOnlyRowHtml).join("")}
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/admin">Admin</a> / Cover letter examples</div>
    <div class="page-header">
      <h1>Cover letter examples</h1>
      <button type="button" class="primary" id="add-letter-btn">+ Add</button>
    </div>
    <p class="field-label">Past cover letters used as style/voice reference for the Writer.</p>
    <div class="card" id="letters-list">
      ${entries.length === 0 ? emptyStateHtml() : entries.map(entryRowHtml).join("")}
    </div>
  `;

  const list = document.getElementById("letters-list");

  function emptyStateHtml() {
    return `<div class="empty-state"><p>No examples yet.</p></div>`;
  }

  function removeEmptyState() {
    list.querySelector(".empty-state")?.remove();
  }

  function wireRow(el) {
    el.querySelector(".letter-edit")?.addEventListener("click", () => {
      const id = el.dataset.id;
      const entry = entries.find((e) => e.id === id);
      el.outerHTML = entryFormHtml(entry.id, entry.text);
      wireForm(list.querySelector(`.admin-edit-form[data-id="${id}"]`), entry);
    });
    el.querySelector(".letter-delete").addEventListener("click", async () => {
      const btn = el.querySelector(".letter-delete");
      if (!window.confirm("Delete this example?")) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/cover-letters/${encodeURIComponent(el.dataset.id)}`, { method: "DELETE" });
        entries = entries.filter((e) => e.id !== el.dataset.id);
        el.remove();
        if (entries.length === 0) list.insertAdjacentHTML("beforeend", emptyStateHtml());
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
      }
    });
  }

  function wireForm(formEl, existingEntry) {
    formEl.querySelector(".letter-cancel").addEventListener("click", () => {
      if (existingEntry) {
        formEl.outerHTML = entryRowHtml(existingEntry);
        wireRow(list.querySelector(`[data-id="${existingEntry.id}"]`));
      } else {
        formEl.remove();
        if (entries.length === 0) list.insertAdjacentHTML("beforeend", emptyStateHtml());
      }
    });

    const saveBtn = formEl.querySelector(".letter-save");
    saveBtn.addEventListener("click", async () => {
      const text = formEl.querySelector(".letter-text").value.trim();
      if (!text) {
        showError("Text is required.");
        return;
      }
      saveBtn.disabled = true; // guards against a duplicate entry from a fast double-click
      try {
        if (existingEntry) {
          await api(`/api/admin/cover-letters/${encodeURIComponent(existingEntry.id)}`, {
            method: "PUT",
            body: JSON.stringify({ text }),
          });
          const updated = { id: existingEntry.id, text, editable: true };
          entries = entries.map((e) => (e.id === existingEntry.id ? updated : e));
          formEl.outerHTML = entryRowHtml(updated);
          wireRow(list.querySelector(`[data-id="${updated.id}"]`));
        } else {
          const { id } = await api("/api/admin/cover-letters", { method: "POST", body: JSON.stringify({ text }) });
          const created = { id, text, editable: true };
          entries = [...entries, created];
          removeEmptyState();
          formEl.outerHTML = entryRowHtml(created);
          wireRow(list.querySelector(`[data-id="${created.id}"]`));
        }
      } catch (err) {
        showError(err.message);
        saveBtn.disabled = false;
      }
    });
  }

  list.querySelectorAll(".admin-list-row").forEach(wireRow);

  document.getElementById("add-letter-btn").addEventListener("click", () => {
    removeEmptyState();
    list.insertAdjacentHTML("afterbegin", entryFormHtml("", ""));
    wireForm(list.querySelector(".admin-edit-form"), undefined);
  });
}
