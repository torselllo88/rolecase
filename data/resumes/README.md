# Resume Library

Drop PDF resumes here — one file per resume variant (e.g. `backend-focused.pdf`,
`leadership-focused.pdf`). The filename (without `.pdf`) becomes the resume's `id`
throughout the system (trace events, `resume-edits.md`, etc.).

Requirements:
- PDFs must have a real text layer (selectable text), not scanned images —
  this project does not do OCR.
- Content is personal/sensitive: this folder's actual PDFs are gitignored, only
  this README and the folder structure are committed.

Text is extracted automatically by `src/tools/resumeLibrary.ts` whenever the
Resume Selector runs. If an LLM provider is configured (OpenRouter or Azure
OpenAI — see the main README's "LLM provider" section), extracted text also
goes through a one-time cleanup pass (cached under `.cache/`, keyed by content
hash) to fix any reading-order scrambling from multi-column layouts or tables —
without it, resumes are used as raw-extracted text, which may occasionally read
out of order for complex layouts.

Resumes can also be uploaded/deleted from the GUI's Admin → Resumes page instead
of copying files here by hand.
