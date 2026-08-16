# Candidate Notes

Free-form background info about you or your projects that doesn't fit as a
resume (a formatted document) or a Q&A pair (`data/answer-examples/`) —
things like an open-source project, a specific achievement, or context you
want the Writer and Evidence Checker to be able to ground claims in even
though it's not on your resume.

You can manage these from the GUI's Admin → Candidate notes page (add/edit/
delete, no file editing needed) instead of hand-editing files here.

If you're editing by hand: drop `.md` or `.txt` files in this folder (any name
except `README.*`) — one note per file, or several in one file separated by
a lone `---` line (on its own, optionally surrounded by whitespace):

```
Maintain an open-source CLI tool with 500+ GitHub stars, used by teams at
several mid-size companies for their internal build tooling.

---

Led a volunteer effort migrating a local nonprofit's site to a modern stack,
outside of paid work.
```

Content here is personal: this folder's actual files are gitignored, only
this README and the folder structure are committed.

These notes are folded into both the initial fit-scoring analysis and the
Writer/Evidence Checker's grounding for cover letters and answers, alongside
your resume — a candidate with notes but no resume on file still gets real
grounding this way. The library caps how much gets forwarded (20,000
characters total — whichever notes fit the budget in file order, see
`src/tools/candidateNotesLibrary.ts`); it's meant as a handful of notable
facts, not a full second resume.
