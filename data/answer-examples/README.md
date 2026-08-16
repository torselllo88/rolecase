# Answer Example Library

Past application-question answers, used as few-shot grounding when the Writer
agent drafts a new answer to a question you've added manually.

You can manage these from the GUI's Admin → Answer examples page (add/edit/
delete, no file editing needed) instead of hand-editing files here.

If you're editing by hand: drop `.md` or `.txt` files in this folder (any name
except `README.*`), each containing one or more `Q:`/`A:` pairs:

```
Q: Why do you want to work here?
A: I love the mission and the engineering culture.

---

Q: Describe a challenge you overcame.
A: I once tracked down a hard production bug by...
```

A lone `---` line (on its own, optionally surrounded by whitespace) separates
multiple pairs within one file — one file can hold one pair or several. Content
here is personal: this folder's actual files are gitignored, only this README
and the folder structure are committed.

The library caps how much of it gets forwarded to the Writer's prompt (20,000
characters total — whichever pairs fit the budget in file order, see
`src/tools/answerExampleLibrary.ts`); it's meant as a handful of representative
examples, not an archive of every answer you've ever written.
