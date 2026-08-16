import { api, app, escapeHtml, showError } from "../../shared.js";

function entryRowHtml(entry) {
  if (!entry.editable) {
    return `
      <div class="admin-list-row" data-id="${escapeHtml(entry.id)}">
        <div>
          <span class="badge neutral">legacy file</span>
          <p class="field-label">${escapeHtml(entry.question)}</p>
        </div>
        <div class="actions">
          <button type="button" class="danger example-delete" data-id="${escapeHtml(entry.id)}">Delete</button>
        </div>
      </div>`;
  }
  return `
    <div class="admin-list-row" data-id="${escapeHtml(entry.id)}">
      <div class="qa">
        <div class="q">${escapeHtml(entry.question)}</div>
        <div>${escapeHtml(entry.answer)}</div>
      </div>
      <div class="actions">
        <button type="button" class="example-edit" data-id="${escapeHtml(entry.id)}">Edit</button>
        <button type="button" class="danger example-delete" data-id="${escapeHtml(entry.id)}">Delete</button>
      </div>
    </div>`;
}

function entryFormHtml(id, question, answer) {
  return `
    <div class="admin-list-row admin-edit-form" data-id="${escapeHtml(id || "")}">
      <div style="flex:1">
        <input type="text" class="example-question" placeholder="Question" value="${escapeHtml(question || "")}">
        <textarea class="example-answer guidance-textarea" placeholder="Answer">${escapeHtml(answer || "")}</textarea>
      </div>
      <div class="actions">
        <button type="button" class="primary example-save" data-id="${escapeHtml(id || "")}">Save</button>
        <button type="button" class="example-cancel">Cancel</button>
      </div>
    </div>`;
}

/**
 * Every mutation below patches the DOM/`entries` array directly instead of
 * re-fetching and re-rendering the whole page — the previous version's
 * "just call renderAdminAnswerExamples() again" after every save/cancel/
 * delete silently discarded any OTHER row's still-open, unsaved edit form
 * in the process. Only the initial load does a full render.
 */
export async function renderAdminAnswerExamples() {
  app.innerHTML = `<div class="loading">Loading answer examples…</div>`;
  let entries;
  try {
    ({ entries } = await api("/api/admin/answer-examples"));
  } catch (err) {
    app.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    return;
  }

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/admin">Admin</a> / Answer examples</div>
    <div class="page-header">
      <h1>Answer examples</h1>
      <button type="button" class="primary" id="add-example-btn">+ Add</button>
    </div>
    <p class="field-label">Past question/answer pairs used as few-shot grounding when the Writer answers a new question.</p>
    <div class="card" id="examples-list">
      ${entries.length === 0 ? emptyStateHtml() : entries.map(entryRowHtml).join("")}
    </div>
  `;

  const list = document.getElementById("examples-list");

  function emptyStateHtml() {
    return `<div class="empty-state"><p>No examples yet.</p></div>`;
  }

  function removeEmptyState() {
    list.querySelector(".empty-state")?.remove();
  }

  function wireRow(el) {
    el.querySelector(".example-edit")?.addEventListener("click", () => {
      const id = el.dataset.id;
      const entry = entries.find((e) => e.id === id);
      el.outerHTML = entryFormHtml(entry.id, entry.question, entry.answer);
      wireForm(list.querySelector(`.admin-edit-form[data-id="${id}"]`), entry);
    });
    el.querySelector(".example-delete").addEventListener("click", async () => {
      const btn = el.querySelector(".example-delete");
      if (!window.confirm("Delete this example?")) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/answer-examples/${encodeURIComponent(el.dataset.id)}`, { method: "DELETE" });
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
    formEl.querySelector(".example-cancel").addEventListener("click", () => {
      if (existingEntry) {
        formEl.outerHTML = entryRowHtml(existingEntry);
        wireRow(list.querySelector(`[data-id="${existingEntry.id}"]`));
      } else {
        formEl.remove();
        if (entries.length === 0) list.insertAdjacentHTML("beforeend", emptyStateHtml());
      }
    });

    const saveBtn = formEl.querySelector(".example-save");
    saveBtn.addEventListener("click", async () => {
      const question = formEl.querySelector(".example-question").value.trim();
      const answer = formEl.querySelector(".example-answer").value.trim();
      if (!question || !answer) {
        showError("Both question and answer are required.");
        return;
      }
      saveBtn.disabled = true; // guards against a duplicate entry from a fast double-click
      try {
        if (existingEntry) {
          await api(`/api/admin/answer-examples/${encodeURIComponent(existingEntry.id)}`, {
            method: "PUT",
            body: JSON.stringify({ question, answer }),
          });
          const updated = { id: existingEntry.id, question, answer, editable: true };
          entries = entries.map((e) => (e.id === existingEntry.id ? updated : e));
          formEl.outerHTML = entryRowHtml(updated);
          wireRow(list.querySelector(`[data-id="${updated.id}"]`));
        } else {
          const { id } = await api("/api/admin/answer-examples", {
            method: "POST",
            body: JSON.stringify({ question, answer }),
          });
          const created = { id, question, answer, editable: true };
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

  document.getElementById("add-example-btn").addEventListener("click", () => {
    removeEmptyState();
    list.insertAdjacentHTML("afterbegin", entryFormHtml("", "", ""));
    wireForm(list.querySelector(".admin-edit-form"), undefined);
  });
}
