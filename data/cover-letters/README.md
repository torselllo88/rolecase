# Cover Letter Library

Past cover letters you've written, used as style/voice grounding for the
Writer agent when it drafts a new cover letter — no parsing needed, plain
text is used as-is.

You can manage these from the GUI's Admin → Cover letters page (add/edit/
delete, no file editing needed) instead of hand-editing files here.

If you're editing by hand: drop `.md` or `.txt` files in this folder (any name
except `README.*`) — one letter per file, or several in one file separated by
a lone `---` line (on its own, optionally surrounded by whitespace):

```
Dear Hiring Team,

I'm excited to apply for this role because...

---

Dear Hiring Team,

Your posting for this position caught my attention because...
```

Content here is personal: this folder's actual files are gitignored, only
this README and the folder structure are committed.

The library caps how much of it gets forwarded to the Writer's prompt (20,000
characters total — whichever examples fit the budget in file order, see
`src/tools/coverLetterLibrary.ts`); it's meant as a handful of representative
examples, not an archive of every letter you've ever sent.
