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
          <button type="button" class="danger note-delete" data-id="${escapeHtml(entry.id)}">Delete</button>
        </div>
      </div>`;
  }
  return `
    <div class="admin-list-row" data-id="${escapeHtml(entry.id)}">
      <p>${escapeHtml(truncate(entry.text, 240))}</p>
      <div class="actions">
        <button type="button" class="note-edit" data-id="${escapeHtml(entry.id)}">Edit</button>
        <button type="button" class="danger note-delete" data-id="${escapeHtml(entry.id)}">Delete</button>
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
        <textarea class="note-text guidance-textarea" placeholder="Background info about you or a project" style="min-height:120px">${escapeHtml(text || "")}</textarea>
      </div>
      <div class="actions">
        <button type="button" class="primary note-save" data-id="${escapeHtml(id || "")}">Save</button>
        <button type="button" class="note-cancel">Cancel</button>
      </div>
    </div>`;
}

/** Same "patch the DOM, never re-fetch-and-re-render the whole page" discipline as coverLetters.js/answerExamples.js — see their own doc comments for why. */
export async function renderAdminCandidateNotes() {
  app.innerHTML = `<div class="loading">Loading candidate notes…</div>`;
  let entries;
  try {
    ({ entries } = await api("/api/admin/candidate-notes"));
  } catch (err) {
    app.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    return;
  }

  if (isDemoWorkspace()) {
    app.innerHTML = `
      <div class="breadcrumb"><a href="#/admin">Preview</a> / Candidate notes</div>
      <div class="page-header"><h1>Candidate notes</h1></div>
      <p class="field-label">Free-form background info about the candidate that doesn't fit as a resume or a Q&amp;A pair — used as additional grounding for cover letters and answers.</p>
      ${demoPreviewBannerHtml()}
      <div class="card">
        ${entries.length === 0 ? `<div class="empty-state"><p>No notes yet.</p></div>` : entries.map(readOnlyRowHtml).join("")}
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/admin">Admin</a> / Candidate notes</div>
    <div class="page-header">
      <h1>Candidate notes</h1>
      <button type="button" class="primary" id="add-note-btn">+ Add</button>
    </div>
    <p class="field-label">Free-form background info about you or your projects that doesn't fit as a resume or a Q&amp;A pair — used as additional grounding for cover letters and answers.</p>
    <div class="card" id="notes-list">
      ${entries.length === 0 ? emptyStateHtml() : entries.map(entryRowHtml).join("")}
    </div>
  `;

  const list = document.getElementById("notes-list");

  function emptyStateHtml() {
    return `<div class="empty-state"><p>No notes yet.</p></div>`;
  }

  function removeEmptyState() {
    list.querySelector(".empty-state")?.remove();
  }

  function wireRow(el) {
    el.querySelector(".note-edit")?.addEventListener("click", () => {
      const id = el.dataset.id;
      const entry = entries.find((e) => e.id === id);
      el.outerHTML = entryFormHtml(entry.id, entry.text);
      wireForm(list.querySelector(`.admin-edit-form[data-id="${id}"]`), entry);
    });
    el.querySelector(".note-delete").addEventListener("click", async () => {
      const btn = el.querySelector(".note-delete");
      if (!window.confirm("Delete this note?")) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/candidate-notes/${encodeURIComponent(el.dataset.id)}`, { method: "DELETE" });
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
    formEl.querySelector(".note-cancel").addEventListener("click", () => {
      if (existingEntry) {
        formEl.outerHTML = entryRowHtml(existingEntry);
        wireRow(list.querySelector(`[data-id="${existingEntry.id}"]`));
      } else {
        formEl.remove();
        if (entries.length === 0) list.insertAdjacentHTML("beforeend", emptyStateHtml());
      }
    });

    const saveBtn = formEl.querySelector(".note-save");
    saveBtn.addEventListener("click", async () => {
      const text = formEl.querySelector(".note-text").value.trim();
      if (!text) {
        showError("Text is required.");
        return;
      }
      saveBtn.disabled = true; // guards against a duplicate entry from a fast double-click
      try {
        if (existingEntry) {
          await api(`/api/admin/candidate-notes/${encodeURIComponent(existingEntry.id)}`, {
            method: "PUT",
            body: JSON.stringify({ text }),
          });
          const updated = { id: existingEntry.id, text, editable: true };
          entries = entries.map((e) => (e.id === existingEntry.id ? updated : e));
          formEl.outerHTML = entryRowHtml(updated);
          wireRow(list.querySelector(`[data-id="${updated.id}"]`));
        } else {
          const { id } = await api("/api/admin/candidate-notes", { method: "POST", body: JSON.stringify({ text }) });
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

  document.getElementById("add-note-btn").addEventListener("click", () => {
    removeEmptyState();
    list.insertAdjacentHTML("afterbegin", entryFormHtml("", ""));
    wireForm(list.querySelector(".admin-edit-form"), undefined);
  });
}
