# RoleCase

<!-- Replace OWNER/REPO once this is pushed to GitHub. -->
[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

An AI assistant for evaluating job opportunities and drafting tailored applications,
with human approval at every step. A multi-agent system that analyzes a job vacancy
and, after human approval, drafts a full application package. See `README.txt` for
the original design brief. This file covers setting the project up on a machine —
including a fresh one.

Not affiliated with or endorsed by OpenAI, Anthropic, OpenRouter, or Brave Search —
this project is an independent client of their public APIs, referenced here only to
describe what it connects to.

## Setup on a fresh machine

The fastest path — unpack, then one command:

```
npm start
```

This installs dependencies and launches the GUI at `http://localhost:3939`, all in
one step (`npm run setup && npm run gui` — see `package.json`). It works with **zero
configuration**: without a `.env`, every agent falls back to a deterministic stub (no
crash, no real API calls), so you get a fully working, click-through demo
immediately. Fill in `.env` (step 4 below) whenever you're ready for real LLM calls —
or skip `.env` entirely and set your provider/key from the GUI itself, in
Admin → Settings (see "Customization" below).

Longer version, if you want to run steps individually or use the CLI instead:

1. Install [Node.js](https://nodejs.org/) ≥ 22.5.0.
2. Clone or unzip this project folder anywhere — nothing here depends on a fixed
   install path.
3. Run the setup command:
   ```
   npm run setup
   ```
   Today this is just `npm install` — kept as its own script (rather than telling
   you to run `npm install` directly) so step 6 below and `npm start` never need to
   change if a future dependency ever needs a real setup step again.
4. Copy `.env.example` to `.env` and fill in your real API keys. **Never commit or
   zip up a populated `.env`** — it's already gitignored, and no script in this
   project ever bundles it into an archive for you.
5. Run `npm test` to confirm a clean install. The test suite is fully hermetic (it
   blanks all secret env vars before running), so it passes with no keys configured
   at all.
6. Use it:
   - `npm run cli` — command-line interface.
   - `npm run gui` — local web GUI at `http://localhost:3939` (the primary way to
     use this day to day).
   - `npm run mcp` — MCP server exposing the same tools to any MCP-compatible client.

`npm run build` (a `tsc` type-check) is a development-time gate, not required for any
of the above — the CLI/GUI/MCP entry points all run directly against TypeScript
source via `tsx`. For this project, "build" *is* `npm run setup`.

## Multi-workspace mode: Admin / Demo / Workbenches

Everything above describes the default: one shared instance at `/`, no login
— exactly as if this section didn't exist. Setting `ADMIN_PASSWORD` in `.env`
switches the same process to path-prefixed routing instead:

- **`/admin`** — the same data (`data/`) you were already using, now
  password-gated so it can be reached remotely. Nothing about your
  resumes/runs/settings changes.
- **`/demo`** (optional — also needs `ENABLE_DEMO=true`, its own independent
  flag) — public, no login. LLM calls and company/salary search are always
  stubbed here regardless of any real key configured elsewhere, so a public
  visitor can never trigger a real (costly) call. A visitor can paste their
  own resume for a more grounded result — used for that one application
  only, never written to the shared Resume Library, never visible to anyone
  else. Runs older than `DEMO_RUN_TTL_HOURS` are swept away automatically.
- **`/workbench/<slug>`** (optional, any number of them) — for friends: each
  is created from Admin → Workbenches (name + password), with its own
  independent resumes/answer examples/cover letters/candidate notes/run
  history/generation defaults, stored under `data/workspaces/` (gitignored —
  this is other people's content, not yours). A workbench with no
  OpenRouter/Azure key of its own falls back to the admin's key, then to
  `.env` — set one explicitly in that workbench's own Admin → Settings only
  if you want it to use a different key/model.

This is meant to be reached over an SSH tunnel by default
(`ssh -L 3939:localhost:3939 you@host`, then browse `http://localhost:3939/admin`
as normal) rather than exposed publicly — the process itself only ever binds
`127.0.0.1`. If you do put a reverse proxy in front of it, set
`TRUSTED_CLIENT_IP_HEADER` to whatever header that proxy actually *sets* (not
appends to) with the real visitor's address (e.g. nginx's
`proxy_set_header X-Real-IP $remote_addr;`) — otherwise the login/demo rate
limiters below all see the proxy's own address instead of the real visitor's,
and either block everyone as one "IP" or block no one. Set
`COOKIE_SECURE=true` once that proxy terminates TLS for you.

Related `.env` vars (see `.env.example` for defaults): `ADMIN_PASSWORD`,
`ENABLE_DEMO`, `DEMO_RUN_TTL_HOURS`, `DEMO_RATE_LIMIT_PER_HOUR`,
`LOGIN_RATE_LIMIT_PER_HOUR`, `TRUSTED_CLIENT_IP_HEADER`, `COOKIE_SECURE`.

## Moving to another machine

Treat the portable unit as the source tree only — regenerate everything else on the
new machine rather than copying it:

- **Don't bring**: `node_modules/`, `dist/`, `data/db/*.sqlite3*`. All regenerate
  (`npm run setup` / first run / `npm run build`), and `node_modules` in particular
  may not even work copied as-is across machines.
- **Copy manually if you want continuity** (never via git — none of this is tracked):
  `.env`, `data/resumes/`, `data/cover-letters/`, `data/answer-examples/`,
  `data/candidate-notes/`, and, only if you want existing run history,
  `data/db/app.sqlite3` (+ its `-wal`/`-shm` files) and `data/runs/`. Running
  workbenches (see "Multi-workspace mode" above)? Their data lives under
  `data/workspaces/` — copy that too if you want continuity for them.

**`scripts/pack-for-transfer.sh`** builds the archive for you, with the above baked
in — it never deletes or modifies anything on this machine, it just leaves the
regenerable/run-specific paths out of the `.tar.gz` it writes:

```
scripts/pack-for-transfer.sh                    # keeps your resumes/cover letters/answer examples/candidate notes
scripts/pack-for-transfer.sh --strip-personal   # also leaves those out (a clean, no-personal-data template)
scripts/pack-for-transfer.sh --strip-personal /path/to/output/dir   # optional: where to write the archive
```

Always excluded, regardless of flags: `node_modules/`, `dist/`, `.vitest-data/`,
`data/db/*.sqlite3*`, `data/runs/`, `data/workspaces/` (workbench data — other
people's content), and `.env` (this project never bundles secrets into an archive
for you — copy `.env` by hand if you want the new machine to have your real API
keys). Without `--strip-personal`, `data/resumes/`, `data/cover-letters/`,
`data/answer-examples/`, and `data/candidate-notes/` are included, for continuity.
Without an explicit output path, the archive is written one level above the
project folder (never inside it).

## Customization: what to edit, and where

Everything you'd plausibly want to change on a new machine, in one place:

**Your profile (resume, writing style, past answers, other background)** — manage
all four from **Admin** in the GUI (upload/add/edit/delete, no file editing needed),
or drop files into the folders below by hand if you're CLI-only:
- `data/resumes/` — PDF resumes, one file per variant. See `data/resumes/README.md`.
- `data/cover-letters/` — past cover letters, for style/voice grounding. See
  `data/cover-letters/README.md`.
- `data/answer-examples/` — past application-question answers, for grounding. See
  `data/answer-examples/README.md`.
- `data/candidate-notes/` — free-form background info about you or your projects
  that doesn't fit as a resume or a Q&A pair (e.g. an open-source project not on
  your resume) — additional grounding for the Writer and Evidence Checker, and for
  the initial fit-scoring analysis. See `data/candidate-notes/README.md`.

All four are optional (an empty folder just means less grounding — the app still
works) and are gitignored on purpose: only the folder structure and its README are
tracked, so your personal content never ends up in git or in an archive you didn't
build yourself.

**Admin panel** (GUI only, no CLI equivalent yet) — the sidebar's Admin section
covers everything above plus generation defaults, LLM provider/keys, and (in the
actual admin workspace) Workbenches — see "Multi-workspace mode" above:
Resumes, Answer examples, Cover letters, Candidate notes, and Settings (default
word limits, default cover-letter/humanize-style/avoid-overfitting toggles, agent
instructions, and OpenRouter/Azure provider selection — an alternative to editing
`.env`, stored in the SQLite DB and applied immediately without a restart).

**Agent prompts** — two ways to adjust agent behavior, from lightest to heaviest:
- **Admin → Settings → "Agent instructions (advanced)"** — a free-text note per
  agent, appended to the end of that agent's own system prompt (additive only,
  never a full replacement — the agent's structured-output contract stays intact
  either way). Takes effect on the next run, no restart. Good for tone/scope
  nudges ("keep answers under 3 sentences unless asked for more"); keep it short
  and behavioral, not a request to change the response format.
- **Edit the source directly** — for anything beyond an additive nudge. These are
  TypeScript string constants, not separate config files, so editing one means
  editing source and (if you're running via `tsx`, the default) the change takes
  effect on the next run with no rebuild step:
  - `src/agents/vacancyAnalyzerAgent.ts` — `PARSE_ONLY_SYSTEM_PROMPT` /
    `PARSE_AND_FIT_SYSTEM_PROMPT` (vacancy parsing + fit scoring).
  - `src/agents/companyResearchAgent.ts` — `SYNTHESIS_SYSTEM_PROMPT`.
  - `src/agents/resumeSelectorAgent.ts` — `SYSTEM_PROMPT`.
  - `src/agents/writerAgent.ts` — `BODY_INSTRUCTIONS` (folded into a per-call
    system prompt built by `buildSystemPrompt()`).
  - `src/agents/criticAgent.ts` — `SYSTEM_PROMPT`.
  - `src/agents/evidenceCheckerAgent.ts` — `SYSTEM_PROMPT`.
  - `src/tools/resumeLibrary.ts` — `NORMALIZE_SYSTEM_PROMPT` (the one-time
    PDF-text cleanup pass, not an "agent" but still an LLM call).

**Settings** — the app-wide defaults (Writer length limits, default cover-letter/
humanize-style/avoid-overfitting toggles, per-agent instructions, LLM provider/keys,
and the Brave Search key) can be set either from Admin → Settings in the GUI (stored
in `data/db/app.sqlite3`, takes effect immediately) or in `.env` (copy from
`.env.example`) — a value set in the GUI wins over `.env` when both are present.
The Brave Search key is a separate credential from the LLM keys, used only by
Company Research's web search — set it too, or company/salary research always
falls back to a deterministic stub regardless of whether an LLM is configured.
"Avoid overfitting" asks the Writer/
Critic not to over-mirror a vacancy posting's exact wording back at it — a separate
toggle from "humanize style" (which targets AI-writing tells), both off by default,
each overridable per-run in the generate form. A run's own generate form can also
set a country/location to benchmark salary research against, overriding the
vacancy's own stated location — useful for a remote role. Two path/network
overrides only live in `.env`, since they're read before the database even exists:
- `DATA_DIR` — redirects the SQLite DB and every run artifact away from `./data`.
- `GUI_PORT` — the GUI's port, default `3939`.

**Where things end up** — not configuration, but worth knowing when moving machines
or debugging: `data/db/app.sqlite3` (run state and admin settings) and
`data/runs/<runId>/` (that run's vacancy report and generated application package as
plain files — `vacancy-report.md`, `application-package/`, etc.). Both are
gitignored; see "Moving to another machine" above for what to bring.

## LLM provider

Set `OPENROUTER_API_KEY` (see `.env.example`) to use OpenRouter, or `AZURE_OPENAI_API_KEY`
to use Azure OpenAI — both are supported side by side. Leave `LLM_PROVIDER` unset to
auto-detect (OpenRouter wins if configured, else Azure, else every agent falls back
to its deterministic stub — no crash, no real calls). Set `LLM_PROVIDER` explicitly
only if you want an unconfigured choice to fail loudly instead.
