/**
 * A plain string run idempotently by db.ts on startup (CREATE TABLE/INDEX IF
 * NOT EXISTS), rather than a .sql asset file — tsc does not copy non-.ts files
 * into dist/, and a migration this small doesn't warrant a build-step or a
 * migration framework.
 */
export const INIT_SQL = `
-- failed_from_state records which "in-progress" state (ANALYZING, GENERATING_PACKAGE)
-- the run was in when it hit FAILED, so a retry of the same command can be
-- distinguished from a retry of a different command after a crash.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  vacancy_source_type TEXT NOT NULL,
  vacancy_source TEXT NOT NULL,
  vacancy_title TEXT,
  company_name TEXT,
  recommendation TEXT,
  package_iteration_count INTEGER NOT NULL DEFAULT 0,
  regenerate_attempt_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  failed_from_state TEXT,
  -- Only ever populated for the demo workspace (its anonymous session token doubles
  -- as this id); null for admin/workbench runs. New DBs get this column straight
  -- from CREATE TABLE; a pre-existing DB needs db.ts's PRAGMA-guarded ALTER TABLE,
  -- since CREATE TABLE IF NOT EXISTS is a no-op against an already-existing table.
  visitor_id TEXT,
  -- User-supplied country/location to benchmark salary research against,
  -- overriding the vacancy's own stated location (useful for a remote role
  -- where the posting's location doesn't match where the applicant actually
  -- lives). Same pre-existing-DB migration note as visitor_id above.
  salary_location_override TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  agent_name TEXT,
  tool_name TEXT,
  request_json TEXT,
  response_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  token_usage_json TEXT,
  estimated_cost_usd REAL,
  iteration INTEGER,
  from_state TEXT,
  to_state TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trace_events_run_id_seq ON trace_events(run_id, seq);

-- Single-row table (id is always 1) holding admin-editable app-wide config —
-- generation defaults and LLM provider/keys. Populated lazily on first read
-- (see settingsRepository.ts); every column is nullable, meaning "fall back
-- to the matching .env value" — the same override-then-fallback convention
-- generate()'s own per-run settings already use.
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_limits_json TEXT,
  default_include_cover_letter INTEGER,
  default_humanize_style INTEGER,
  default_avoid_overfitting INTEGER,
  llm_provider TEXT,
  openrouter_api_key TEXT,
  openrouter_model TEXT,
  azure_api_key TEXT,
  azure_endpoint TEXT,
  azure_api_version TEXT,
  azure_deployment TEXT,
  -- Free-text addenda appended to each agent's own system prompt, keyed by
  -- AgentName (see baseAgent.ts's withPromptAddendum()) — JSON object,
  -- e.g. {"WRITER": "..."}. Additive only, never a full prompt replacement.
  agent_instructions_json TEXT,
  -- Separate credential from the LLM keys above — used only by CompanyResearchAgent's
  -- SearchBroker. Independently configurable so setting an LLM key alone doesn't get
  -- mistaken for also covering search grounding (see src/tools/searchBroker.ts).
  brave_search_api_key TEXT,
  -- Per-consumer OpenRouter model override, THIS workspace's own (JSON object
  -- keyed by ModelConsumer) — see providerFactory.ts's resolveProviderConfigs()
  -- and llm/openRouterProvider.ts's modelFor(). Independent of the admin's
  -- own .env-level LLM_MODEL_* overrides, which used to be the only thing
  -- that could win here regardless of workspace.
  openrouter_model_by_consumer_json TEXT,
  -- Caps the Writer/Critic refinement loop for this workspace's runs; null
  -- means the hardcoded default (see writerCriticLoop.ts).
  max_writer_critic_iterations INTEGER,
  updated_at TEXT NOT NULL
);

-- Identity/auth only for admin-managed workbenches — lives in the ADMIN
-- workspace's own db, never in a workbench's own db file. A workbench's LLM/
-- generation settings live in ITS OWN app_settings row (its own db file, same
-- table above) — this table deliberately holds nothing but who/how-to-log-in.
CREATE TABLE IF NOT EXISTS workspaces (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_salt_hex TEXT NOT NULL,
  password_hash_hex TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
