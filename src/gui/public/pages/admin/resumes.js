import { api, app, escapeHtml, formatDate, showError } from "../../shared.js";

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function rowHtml(r) {
  const typeBadge = r.type === "pdf" ? "" : `<span class="badge info">text</span> `;
  const editBtn = r.type === "text" ? `<button type="button" class="resume-edit" data-id="${escapeHtml(r.id)}">Edit</button>` : "";
  return `
    <div class="admin-list-row" data-id="${escapeHtml(r.id)}">
      <div>
        <strong>${typeBadge}${escapeHtml(r.fileName)}</strong>
        <div class="field-label">${formatBytes(r.sizeBytes)} · uploaded ${escapeHtml(formatDate(r.uploadedAt))}</div>
      </div>
      <div class="actions">
        ${editBtn}
        <button type="button" class="danger resume-delete" data-id="${escapeHtml(r.id)}">Delete</button>
      </div>
    </div>`;
}

function editFormHtml(r) {
  return `
    <div class="admin-list-row admin-edit-form" data-id="${escapeHtml(r.id)}">
      <div style="flex:1">
        <p class="field-label">${escapeHtml(r.fileName)}</p>
        <textarea class="resume-edit-text guidance-textarea" style="min-height:160px">${escapeHtml(r.text || "")}</textarea>
      </div>
      <div class="actions">
        <button type="button" class="primary resume-edit-save" data-id="${escapeHtml(r.id)}">Save</button>
        <button type="button" class="resume-edit-cancel">Cancel</button>
      </div>
    </div>`;
}

export async function renderAdminResumes() {
  app.innerHTML = `<div class="loading">Loading resumes…</div>`;
  let resumes;
  try {
    ({ resumes } = await api("/api/admin/resumes"));
  } catch (err) {
    app.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    return;
  }

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/admin">Admin</a> / Resumes</div>
    <div class="page-header"><h1>Resumes</h1></div>
    <div class="card">
      <div class="upload-dropzone" id="resume-dropzone">
        <p>Drag a PDF here, or</p>
        <label class="upload-browse-btn">
          Browse files
          <input type="file" id="resume-file-input" accept="application/pdf" hidden>
        </label>
      </div>
      <div id="resume-upload-feedback"></div>
    </div>
    <div class="card">
      <h2>Or paste resume text</h2>
      <p class="field-label">No PDF needed — paste plain text directly, e.g. from a Google Doc.</p>
      <input type="text" id="resume-text-name" placeholder="Name this resume (e.g. Backend-focused)">
      <textarea id="resume-text-content" class="guidance-textarea" placeholder="Paste resume text here" style="min-height:120px"></textarea>
      <div class="actions">
        <button type="button" class="primary" id="resume-text-save">Save</button>
      </div>
      <div id="resume-text-feedback"></div>
    </div>
    <div class="card" id="resumes-list">
      ${resumes.length === 0 ? emptyStateHtml() : resumes.map(rowHtml).join("")}
    </div>
  `;

  const list = document.getElementById("resumes-list");

  function emptyStateHtml() {
    return `<div class="empty-state"><p>No resumes yet.</p></div>`;
  }

  function removeEmptyState() {
    list.querySelector(".empty-state")?.remove();
  }

  const dropzone = document.getElementById("resume-dropzone");
  const fileInput = document.getElementById("resume-file-input");

  async function uploadFile(file) {
    const feedback = document.getElementById("resume-upload-feedback");
    feedback.innerHTML = `<div class="loading">Uploading…</div>`;
    try {
      const contentBase64 = await fileToBase64(file);
      const { id } = await api("/api/admin/resumes", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, contentBase64 }),
      });
      feedback.innerHTML = "";
      removeEmptyState();
      const created = { id, fileName: file.name, sizeBytes: file.size, uploadedAt: new Date().toISOString(), type: "pdf" };
      resumes = [...resumes, created];
      list.insertAdjacentHTML("afterbegin", rowHtml(created));
      wireRow(list.querySelector(`[data-id="${id}"]`));
    } catch (err) {
      feedback.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  });
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });

  const textSaveBtn = document.getElementById("resume-text-save");
  textSaveBtn.addEventListener("click", async () => {
    const nameInput = document.getElementById("resume-text-name");
    const textInput = document.getElementById("resume-text-content");
    const name = nameInput.value.trim();
    const text = textInput.value.trim();
    const feedback = document.getElementById("resume-text-feedback");
    if (!name || !text) {
      feedback.innerHTML = `<div class="error-banner">Both a name and the resume text are required.</div>`;
      return;
    }
    textSaveBtn.disabled = true; // guards against a duplicate entry from a fast double-click
    try {
      const { id } = await api("/api/admin/resumes", { method: "POST", body: JSON.stringify({ name, text }) });
      feedback.innerHTML = "";
      nameInput.value = "";
      textInput.value = "";
      removeEmptyState();
      const created = {
        id,
        fileName: `${id}.txt`,
        sizeBytes: new TextEncoder().encode(text).length,
        uploadedAt: new Date().toISOString(),
        type: "text",
        text,
      };
      resumes = [...resumes, created];
      list.insertAdjacentHTML("afterbegin", rowHtml(created));
      wireRow(list.querySelector(`[data-id="${id}"]`));
    } catch (err) {
      feedback.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    } finally {
      textSaveBtn.disabled = false;
    }
  });

  function wireRow(el) {
    el.querySelector(".resume-edit")?.addEventListener("click", () => {
      const id = el.dataset.id;
      const entry = resumes.find((r) => r.id === id);
      el.outerHTML = editFormHtml(entry);
      wireForm(list.querySelector(`.admin-edit-form[data-id="${id}"]`), entry);
    });
    el.querySelector(".resume-delete").addEventListener("click", async () => {
      const btn = el.querySelector(".resume-delete");
      if (!window.confirm("Delete this resume? This cannot be undone.")) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/resumes/${encodeURIComponent(el.dataset.id)}`, { method: "DELETE" });
        resumes = resumes.filter((r) => r.id !== el.dataset.id);
        el.remove();
        if (list.children.length === 0) list.insertAdjacentHTML("beforeend", emptyStateHtml());
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
      }
    });
  }

  function wireForm(formEl, entry) {
    formEl.querySelector(".resume-edit-cancel").addEventListener("click", () => {
      formEl.outerHTML = rowHtml(entry);
      wireRow(list.querySelector(`[data-id="${entry.id}"]`));
    });
    const saveBtn = formEl.querySelector(".resume-edit-save");
    saveBtn.addEventListener("click", async () => {
      const text = formEl.querySelector(".resume-edit-text").value.trim();
      if (!text) {
        showError("Resume text cannot be empty.");
        return;
      }
      saveBtn.disabled = true;
      try {
        await api(`/api/admin/resumes/${encodeURIComponent(entry.id)}`, { method: "PUT", body: JSON.stringify({ text }) });
        const updated = { ...entry, text, sizeBytes: new TextEncoder().encode(text).length };
        resumes = resumes.map((r) => (r.id === entry.id ? updated : r));
        formEl.outerHTML = rowHtml(updated);
        wireRow(list.querySelector(`[data-id="${updated.id}"]`));
      } catch (err) {
        showError(err.message);
        saveBtn.disabled = false;
      }
    });
  }

  list.querySelectorAll(".admin-list-row").forEach(wireRow);
}
