#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { runWithWorkspace, type WorkspaceKind } from "../config/workspaceContext.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { IllegalTransitionError, InvalidActionStateError } from "../orchestrator/workflowState.js";
import type { WriterLimitsOverride } from "../config/env.js";
import type { VacancySourceType } from "../types/vacancy.js";
import { AgentName } from "../types/agent.js";
import type { ModelConsumer } from "../llm/provider.js";
import type { ManualQuestion } from "../types/generationSettings.js";
import type { WorkflowRun } from "../types/workflow.js";
import { fileStore } from "../persistence/fileStore.js";
import type { AppSettings, AppSettingsUpdate } from "../persistence/settingsRepository.js";
import {
  createWorkbench,
  deleteWorkbench,
  getWorkbench,
  listWorkbenches,
  renameWorkbench,
  updateWorkbenchPassword,
} from "../persistence/workspaceRegistry.js";
import {
  createAnswerExampleEntry,
  deleteAnswerExampleEntry,
  listAnswerExampleEntries,
  updateAnswerExampleEntry,
} from "../tools/answerExampleLibrary.js";
import {
  createCoverLetterEntry,
  deleteCoverLetterEntry,
  listCoverLetterEntries,
  updateCoverLetterEntry,
} from "../tools/coverLetterLibrary.js";
import {
  createCandidateNoteEntry,
  deleteCandidateNoteEntry,
  listCandidateNoteEntries,
  updateCandidateNoteEntry,
} from "../tools/candidateNotesLibrary.js";
import {
  createResumeTextEntry,
  deleteResumeFile,
  listResumeFiles,
  saveResumeFile,
  updateResumeTextEntry,
} from "../tools/resumeLibrary.js";
import { hashWorkbenchPassword, verifyAdminPassword, verifyWorkbenchPassword } from "./auth/password.js";
import { createSession, destroySession, destroySessionsForWorkspace, getSession } from "./auth/session.js";
import {
  evictOrchestratorForWorkspace,
  getOrchestratorForWorkspace,
  peekOrchestratorForWorkspace,
  refreshWorkbenchLlmProviders,
} from "./orchestratorRegistry.js";
import { FixedWindowRateLimiter, resolveClientIp } from "./rateLimiter.js";
import { closeDb } from "../persistence/db.js";
import {
  demoDescriptorIfEnabled,
  isWorkspacesEnabled,
  resolveWorkspace,
  rootRedirectTarget,
  workbenchDataDir,
  type WorkspaceDescriptor,
} from "./workspaces.js";

/**
 * Second presentation layer over the same Orchestrator the CLI drives — this
 * is exactly the boundary increment 1 was built for: Orchestrator does no
 * console I/O, so this file is the only place that turns its structured
 * results into HTTP responses. No new framework: the route surface is small
 * (~10 endpoints) and Node's built-in http/routing covers it without adding
 * a dependency for its own sake.
 */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
/** PORT is the convention most PaaS platforms (Railway, Render, Heroku, ...) inject and route to — it wins over the local-dev-only GUI_PORT when both are set. */
const PORT = Number(process.env.PORT ?? process.env.GUI_PORT ?? 3939);
/** Loopback by default — a plain `npm start` on your own machine should never be reachable from the network. Deploying behind a platform's own edge proxy (Railway, Render, ...) or your own reverse proxy requires opting in with GUI_HOST=0.0.0.0. */
const HOST = process.env.GUI_HOST ?? "127.0.0.1";

/** Thrown by readJsonBody()/route parsing for a client-caused request problem — errorStatusAndMessage() maps it straight to its own status code instead of a generic 500. */
class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const ACTIONS = {
  approve: "approve",
  reject: "reject",
  generate: "generate",
  accept: "accept",
  "reject-package": "rejectPackage",
  "confirm-submit": "confirmSubmit",
  retry: "retryAnalysis",
} as const;
type ActionKey = keyof typeof ACTIONS;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

// A cross-origin <form method="POST" enctype="text/plain"> submission is one
// of the three CORS-"safelisted" content types a browser will send without a
// preflight check (the other two are the default form encodings) — any page
// the user's browser visits could otherwise silently POST to every endpoint
// below on their behalf (create runs on their LLM budget, plant fake resume/
// answer-example entries, drive an existing run). Requiring the exact
// application/json content type this app's own frontend already sends
// (see shared.js's api()) forces a real cross-origin attempt through a CORS
// preflight instead — which this server never opts into (no OPTIONS handling,
// no Access-Control-* headers), so the browser blocks it before it arrives.
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(;.*)?$/i;
const MAX_BODY_BYTES = 25 * 1024 * 1024; // Generous enough for a base64 resume upload, small enough to bound memory use per request.

/**
 * Checked unconditionally for every POST/PUT in the main dispatcher below —
 * NOT only from inside readJsonBody(). A body-less action route (approve,
 * reject, accept, reject-package, confirm-submit) never calls readJsonBody()
 * at all, so gating the check on "did this handler try to read a body"
 * left exactly those five routes reachable via a plain cross-origin form
 * POST with no body — the same attack this was meant to close, just against
 * routes that don't happen to need one.
 */
function requireJsonContentType(req: http.IncomingMessage): void {
  const contentType = (req.headers["content-type"] ?? "").trim();
  if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  requireJsonContentType(req);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Shared with handleCreateRun's own inference so both agree on the same "looks like a URL" rule. */
function inferSourceType(source: string, explicit: unknown): VacancySourceType {
  if (explicit === "url" || explicit === "raw_text") return explicit;
  return /^https?:\/\//i.test(source) ? "url" : "raw_text";
}

function parseWriterLimitsOverride(body: Record<string, unknown>): WriterLimitsOverride {
  const positiveNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

  return {
    coverLetterMinWords: positiveNumber(body.coverLetterMinWords),
    coverLetterMaxWords: positiveNumber(body.coverLetterMaxWords),
    answerMaxWords: positiveNumber(body.answerMaxWords),
  };
}

/**
 * Same three fields as parseWriterLimitsOverride, but for the admin
 * Settings PUT specifically — only sets a key on the returned object when
 * `raw` actually contains it (`"key" in raw`), so SettingsRepository's own
 * `{ ...current.defaultLimits, ...changes.defaultLimits }` merge only
 * touches fields the caller genuinely mentioned. Unlike the per-run form
 * (which always resends all three), a script/CLI/future integration sending
 * a genuinely partial `{answerMaxWords: 500}` must not silently wipe the
 * other two back to unset — that was a real, if UI-masked, bug. A field
 * present but `null`/invalid clears that one limit back to the env default;
 * a field simply absent from `raw` is left untouched.
 */
function parsePartialWriterLimits(raw: Record<string, unknown>): WriterLimitsOverride {
  const result: WriterLimitsOverride = {};
  for (const key of ["coverLetterMinWords", "coverLetterMaxWords", "answerMaxWords"] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    result[key] = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }
  return result;
}

/** Every explicit-clear-back-to-default sentinel for defaultLimits — used when the client sends `defaultLimits: null` (or any non-object) to mean "clear all three". */
const CLEARED_WRITER_LIMITS: WriterLimitsOverride = {
  coverLetterMinWords: undefined,
  coverLetterMaxWords: undefined,
  answerMaxWords: undefined,
};

/**
 * Undefined (not an empty array) when the field is absent from the body, so
 * Orchestrator.generate() can tell "no manualQuestions key sent" (fall back to
 * whatever's already persisted) apart from "explicitly cleared to zero
 * questions" (an empty array).
 */
function parseManualQuestions(body: Record<string, unknown>): ManualQuestion[] | undefined {
  if (!Array.isArray(body.manualQuestions)) return undefined;

  const positiveNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

  return body.manualQuestions.flatMap((raw): ManualQuestion[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const { id, question, maxCharacters, guidance } = raw as Record<string, unknown>;
    if (typeof id !== "string" || typeof question !== "string" || !question.trim()) return [];
    return [
      {
        id,
        question: question.trim(),
        maxCharacters: positiveNumber(maxCharacters),
        guidance: typeof guidance === "string" && guidance.trim() ? guidance.trim() : undefined,
      },
    ];
  });
}

/** Undefined (not `true`) when absent from the body — Orchestrator.generate() then falls back to whatever's already persisted. */
function parseIncludeCoverLetter(body: Record<string, unknown>): boolean | undefined {
  return typeof body.includeCoverLetter === "boolean" ? body.includeCoverLetter : undefined;
}

/** Same shape as parseIncludeCoverLetter. */
function parseHumanizeStyle(body: Record<string, unknown>): boolean | undefined {
  return typeof body.humanizeStyle === "boolean" ? body.humanizeStyle : undefined;
}

/** Same shape as parseIncludeCoverLetter. */
function parseAvoidOverfitting(body: Record<string, unknown>): boolean | undefined {
  return typeof body.avoidOverfitting === "boolean" ? body.avoidOverfitting : undefined;
}

/** Undefined when absent; drops any non-string values rather than rejecting the whole map. */
function parseGuidanceById(body: Record<string, unknown>): Record<string, string> | undefined {
  if (typeof body.guidanceById !== "object" || body.guidanceById === null) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.guidanceById as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) result[key] = value.trim();
  }
  return result;
}

/** Undefined when no (or blank) source text was sent — retryAnalysis() then keeps the run's existing source. */
function parseSourceOverride(
  body: Record<string, unknown>
): { sourceType: VacancySourceType; source: string } | undefined {
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) return undefined;
  return { sourceType: inferSourceType(source, body.sourceType), source };
}

/** Undefined = field omitted (leave as-is); null = explicit clear; string = set. Mirrors requireStringOrNull below. */
function parseSalaryLocationOverride(body: Record<string, unknown>): string | null | undefined {
  if (!("salaryLocationOverride" in body)) return undefined;
  const value = body.salaryLocationOverride;
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "salaryLocationOverride must be a string or null");
  return value.trim() || null;
}

/** Never echoes back a real key value — only whether one is currently set. */
function maskSettings(settings: AppSettings): Record<string, unknown> {
  return {
    defaultLimits: settings.defaultLimits,
    defaultIncludeCoverLetter: settings.defaultIncludeCoverLetter,
    defaultHumanizeStyle: settings.defaultHumanizeStyle,
    defaultAvoidOverfitting: settings.defaultAvoidOverfitting,
    agentInstructions: settings.agentInstructions,
    llmProvider: settings.llmProvider,
    openRouterModel: settings.openRouterModel,
    openRouterApiKeyConfigured: Boolean(settings.openRouterApiKey),
    openRouterModelByConsumer: settings.openRouterModelByConsumer,
    azureEndpoint: settings.azureEndpoint,
    azureApiVersion: settings.azureApiVersion,
    azureDeployment: settings.azureDeployment,
    azureApiKeyConfigured: Boolean(settings.azureApiKey),
    braveSearchApiKeyConfigured: Boolean(settings.braveSearchApiKey),
    maxWriterCriticIterations: settings.maxWriterCriticIterations,
    updatedAt: settings.updatedAt,
  };
}

/** `field` present in `body` but neither `null` nor the expected type — a typo/wrong-type value should be rejected loudly, not silently coerced into "clear this setting." */
function requireStringOrNull(body: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string or null`);
  return value.trim() || null;
}

/**
 * Builds an update from only the fields the client actually sent — mirrors
 * SettingsRepository.updateSettings()'s own "key in changes" convention (see
 * its doc comment) so a field genuinely omitted from the body is left alone,
 * while an explicit `null` (e.g. resetting the LLM provider back to
 * auto-detect) is honored rather than silently ignored. Any field present
 * with the WRONG type (a typo'd provider name, a number where a string is
 * expected) throws a 400 instead of silently coercing to `null` — that
 * coercion used to look identical to a deliberate reset.
 */
function parseAdminSettingsUpdate(body: Record<string, unknown>): AppSettingsUpdate {
  const changes: AppSettingsUpdate = {};

  if ("defaultLimits" in body) {
    const raw = body.defaultLimits;
    if (raw === null) {
      changes.defaultLimits = CLEARED_WRITER_LIMITS;
    } else if (typeof raw === "object" && !Array.isArray(raw)) {
      changes.defaultLimits = parsePartialWriterLimits(raw as Record<string, unknown>);
    } else {
      throw new HttpError(400, "defaultLimits must be an object or null");
    }
  }
  if ("defaultIncludeCoverLetter" in body) {
    const value = body.defaultIncludeCoverLetter;
    if (value !== null && typeof value !== "boolean") {
      throw new HttpError(400, "defaultIncludeCoverLetter must be a boolean or null");
    }
    changes.defaultIncludeCoverLetter = value as boolean | null;
  }
  if ("defaultHumanizeStyle" in body) {
    const value = body.defaultHumanizeStyle;
    if (value !== null && typeof value !== "boolean") {
      throw new HttpError(400, "defaultHumanizeStyle must be a boolean or null");
    }
    changes.defaultHumanizeStyle = value as boolean | null;
  }
  if ("defaultAvoidOverfitting" in body) {
    const value = body.defaultAvoidOverfitting;
    if (value !== null && typeof value !== "boolean") {
      throw new HttpError(400, "defaultAvoidOverfitting must be a boolean or null");
    }
    changes.defaultAvoidOverfitting = value as boolean | null;
  }
  if ("agentInstructions" in body) {
    const raw = body.agentInstructions;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new HttpError(400, "agentInstructions must be an object");
    }
    const validAgentNames = new Set(Object.values(AgentName));
    const agentInstructions: Partial<Record<AgentName, string>> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!validAgentNames.has(key as AgentName)) throw new HttpError(400, `Unknown agent name: ${key}`);
      if (typeof value !== "string") throw new HttpError(400, `agentInstructions.${key} must be a string`);
      // Stored even when blank (not skipped) — the admin settings page always
      // sends every agent's field on save, so a shallow merge must be able to
      // overwrite a previously-set instruction back to "none" when cleared.
      agentInstructions[key as AgentName] = value.trim();
    }
    changes.agentInstructions = agentInstructions;
  }
  if ("openRouterModelByConsumer" in body) {
    const raw = body.openRouterModelByConsumer;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new HttpError(400, "openRouterModelByConsumer must be an object");
    }
    // ModelConsumer = AgentName | "RESUME_LIBRARY" — built by hand since ModelConsumer is a type, not a runtime value.
    const validConsumerNames = new Set<string>([...Object.values(AgentName), "RESUME_LIBRARY"]);
    const openRouterModelByConsumer: Partial<Record<ModelConsumer, string>> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!validConsumerNames.has(key)) throw new HttpError(400, `Unknown model consumer: ${key}`);
      if (typeof value !== "string") throw new HttpError(400, `openRouterModelByConsumer.${key} must be a string`);
      // Stored even when blank — same reasoning as agentInstructions above.
      openRouterModelByConsumer[key as ModelConsumer] = value.trim();
    }
    changes.openRouterModelByConsumer = openRouterModelByConsumer;
  }
  if ("maxWriterCriticIterations" in body) {
    const value = body.maxWriterCriticIterations;
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10)) {
      throw new HttpError(400, "maxWriterCriticIterations must be an integer from 1 to 10, or null");
    }
    changes.maxWriterCriticIterations = value as number | null;
  }
  if ("llmProvider" in body) {
    const value = body.llmProvider;
    if (value !== null && value !== "openrouter" && value !== "azure") {
      throw new HttpError(400, 'llmProvider must be "openrouter", "azure", or null');
    }
    changes.llmProvider = value as "openrouter" | "azure" | null;
  }
  const openRouterModel = requireStringOrNull(body, "openRouterModel");
  if (openRouterModel !== undefined) changes.openRouterModel = openRouterModel;
  const azureEndpoint = requireStringOrNull(body, "azureEndpoint");
  if (azureEndpoint !== undefined) changes.azureEndpoint = azureEndpoint;
  const azureApiVersion = requireStringOrNull(body, "azureApiVersion");
  if (azureApiVersion !== undefined) changes.azureApiVersion = azureApiVersion;
  const azureDeployment = requireStringOrNull(body, "azureDeployment");
  if (azureDeployment !== undefined) changes.azureDeployment = azureDeployment;

  if ("openRouterApiKey" in body) {
    if (typeof body.openRouterApiKey !== "string") throw new HttpError(400, "openRouterApiKey must be a string");
    if (body.openRouterApiKey.trim()) changes.openRouterApiKey = body.openRouterApiKey.trim();
  }
  if (body.clearOpenRouterKey === true) changes.clearOpenRouterKey = true;
  if ("azureApiKey" in body) {
    if (typeof body.azureApiKey !== "string") throw new HttpError(400, "azureApiKey must be a string");
    if (body.azureApiKey.trim()) changes.azureApiKey = body.azureApiKey.trim();
  }
  if (body.clearAzureKey === true) changes.clearAzureKey = true;
  if ("braveSearchApiKey" in body) {
    if (typeof body.braveSearchApiKey !== "string") throw new HttpError(400, "braveSearchApiKey must be a string");
    if (body.braveSearchApiKey.trim()) changes.braveSearchApiKey = body.braveSearchApiKey.trim();
  }
  if (body.clearBraveSearchKey === true) changes.clearBraveSearchKey = true;

  return changes;
}

/**
 * `defaultStatus` lets a caller override what an otherwise-unrecognized
 * plain `Error` maps to — resumeLibrary.ts's validation errors (wrong
 * extension, bad PDF signature, path-traversal id) are all client mistakes,
 * not server faults, so handleUploadResume/handleDeleteResume pass 400
 * instead of accepting the generic 500 default. An `HttpError` (from
 * readJsonBody()/requireJsonContentType()) always keeps its own real status
 * regardless of `defaultStatus` — that's the whole point of it existing.
 */
function errorStatusAndMessage(err: unknown, defaultStatus = 500): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof IllegalTransitionError) return { status: 409, message: err.message };
  if (err instanceof InvalidActionStateError) return { status: 409, message: err.message };
  // RunRepository.getRunOrThrow() throws a plain Error("Run not found: ...")
  // for an unknown id — every run-scoped route inherits this, so it's worth
  // special-casing here rather than in every individual handler.
  if (err instanceof Error && /^Run not found:/.test(err.message)) return { status: 404, message: err.message };
  return { status: defaultStatus, message: err instanceof Error ? err.message : String(err) };
}

/** Guards every route param that gets percent-decoded — a malformed sequence (e.g. a lone "%") throws URIError, which would otherwise surface as a 500. */
function decodeRouteParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "Malformed URL segment");
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Multi-workspace auth/session/rate-limit plumbing
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 12 * 3_600_000; // 12h for password-gated admin/workbench sessions
const DEMO_SESSION_TTL_MS = Math.max(env.demoRunTtlHours, 1) * 3_600_000; // must be >= DEMO_RUN_TTL_HOURS — see readSessionCookie's doc comment

const demoActionLimiter = new FixedWindowRateLimiter(env.demoRateLimitPerHour, 3_600_000);
/** Same expensive-action gate as demo's, for admin/workbench — keyed per-workspace (see its call site) so one workbench's usage never eats into another's or the admin's own budget. */
const workspaceActionLimiter = new FixedWindowRateLimiter(env.workspaceRateLimitPerHour, 3_600_000);
const loginAttemptLimiter = new FixedWindowRateLimiter(env.loginRateLimitPerHour, 3_600_000);
setInterval(() => {
  demoActionLimiter.sweepExpired();
  workspaceActionLimiter.sweepExpired();
  loginAttemptLimiter.sweepExpired();
}, 600_000).unref?.();

function readSessionCookie(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie ?? "";
  const match = /(?:^|;\s*)session=([^;]+)/.exec(header);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    // A malformed percent-escape should behave like "no session", not crash the request.
    return undefined;
  }
}

function setSessionCookie(res: http.ServerResponse, token: string, urlPrefix: string): void {
  const secure = env.cookieSecure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(token)}; HttpOnly; Path=${urlPrefix || "/"}; SameSite=Lax${secure}`
  );
}

function clearSessionCookie(res: http.ServerResponse, urlPrefix: string): void {
  res.setHeader("Set-Cookie", `session=; HttpOnly; Path=${urlPrefix || "/"}; SameSite=Lax; Max-Age=0`);
}

/**
 * Resolves this request's authentication state for its workspace:
 * - legacy (no ADMIN_PASSWORD set): always "authenticated", no cookie ever touched.
 * - demo: never requires a password — auto-issues an anonymous session cookie
 *   on first hit if none is present yet. That token doubles as the run
 *   `visitorId` (see loadResumeLibrary()/createRun()'s per-visitor isolation).
 * - admin/workbench: reads an existing cookie only — never mints one outside
 *   handleLogin(). Also checks the session's own workspaceKey matches this
 *   descriptor's, so a workbench-A cookie can never authenticate workbench-B
 *   even if it somehow arrived here (defense in depth on top of the
 *   Path-scoped cookie the browser itself already restricts).
 */
function resolveRequestAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  descriptor: WorkspaceDescriptor
): { authenticated: boolean; visitorId?: string } {
  if (!descriptor.requiresAuth) {
    if (descriptor.kind !== "demo") return { authenticated: true };
    let token = readSessionCookie(req);
    if (!token || !getSession(token)) {
      token = createSession(descriptor.key, "demo", DEMO_SESSION_TTL_MS);
      setSessionCookie(res, token, descriptor.urlPrefix);
    }
    return { authenticated: true, visitorId: token };
  }
  const token = readSessionCookie(req);
  const session = getSession(token);
  return { authenticated: Boolean(session && session.workspaceKey === descriptor.key) };
}

function verifyDescriptorPassword(descriptor: WorkspaceDescriptor, password: string): boolean {
  if (descriptor.kind === "admin") {
    return env.adminPassword !== undefined && verifyAdminPassword(password, env.adminPassword);
  }
  const slug = descriptor.key.replace(/^workbench:/, "");
  const record = getWorkbench(slug);
  return Boolean(record && verifyWorkbenchPassword(password, record.passwordSaltHex, record.passwordHashHex));
}

async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  descriptor: WorkspaceDescriptor,
  clientIp: string
): Promise<void> {
  if (!loginAttemptLimiter.tryConsume(`${clientIp}:${descriptor.urlPrefix}`)) {
    sendJson(res, 429, { error: "Too many login attempts — try again later." });
    return;
  }
  const body = await readJsonBody(req);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || !verifyDescriptorPassword(descriptor, password)) {
    sendJson(res, 401, { error: "Invalid password" });
    return;
  }
  const token = createSession(descriptor.key, descriptor.kind, SESSION_TTL_MS);
  setSessionCookie(res, token, descriptor.urlPrefix);
  sendJson(res, 200, { ok: true });
}

function handleLogout(req: http.IncomingMessage, res: http.ServerResponse, descriptor: WorkspaceDescriptor): void {
  const token = readSessionCookie(req);
  // Only destroy a session that actually belongs to THIS workspace — same
  // ownership discipline resolveRequestAuth() applies everywhere else, so a
  // token for workspace A can't be used to force-logout workspace B just by
  // replaying it with a different Cookie/path combination.
  if (token && getSession(token)?.workspaceKey === descriptor.key) destroySession(token);
  clearSessionCookie(res, descriptor.urlPrefix);
  sendJson(res, 200, { ok: true });
}

let indexHtmlTemplate: string | undefined;
function serveIndexHtml(res: http.ServerResponse, descriptor: WorkspaceDescriptor): void {
  if (indexHtmlTemplate === undefined) {
    indexHtmlTemplate = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");
  }
  const html = indexHtmlTemplate
    .replace('"__WORKSPACE_BASE_PLACEHOLDER__"', JSON.stringify(descriptor.urlPrefix))
    .replace('"__WORKSPACE_KIND_PLACEHOLDER__"', JSON.stringify(descriptor.kind))
    .replace('"__WORKSPACES_ENABLED_PLACEHOLDER__"', JSON.stringify(String(isWorkspacesEnabled())));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** login.html's heading placeholder sits directly in HTML text content (not inside a JS string like the other placeholders), and a workbench's displayName is admin-entered but still untrusted — escape it before embedding. */
function escapeHtmlServer(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function loginHeadingFor(descriptor: WorkspaceDescriptor): string {
  if (descriptor.kind === "admin") return "Admin sign-in";
  const slug = descriptor.key.replace(/^workbench:/, "");
  const record = getWorkbench(slug);
  return record ? `Sign in to ${record.displayName}'s workbench` : "Workbench sign-in";
}

let loginHtmlTemplate: string | undefined;
function serveLoginPage(res: http.ServerResponse, descriptor: WorkspaceDescriptor): void {
  if (loginHtmlTemplate === undefined) {
    loginHtmlTemplate = fs.readFileSync(path.join(PUBLIC_DIR, "login.html"), "utf-8");
  }
  const html = loginHtmlTemplate
    .replace('"__LOGIN_ACTION_PLACEHOLDER__"', JSON.stringify(`${descriptor.urlPrefix}/login`))
    .replace('"__WORKSPACE_ROOT_PLACEHOLDER__"', JSON.stringify(descriptor.urlPrefix || "/"))
    .replace("__LOGIN_HEADING_PLACEHOLDER__", escapeHtmlServer(loginHeadingFor(descriptor)));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Actually-expensive routes (agent/LLM/network work), for both demo's and admin/workbench's rate limiters — pure state transitions (approve/reject/accept/reject-package/confirm-submit) do none and aren't limited. */
function isExpensiveActionRoute(method: string | undefined, pathname: string): boolean {
  if (method !== "POST") return false;
  if (pathname === "/api/runs") return true;
  if (RUN_PIECE_REGENERATE_PATTERN.test(pathname)) return true;
  if (RUN_PIECE_CREATE_PATTERN.test(pathname)) return true;
  const actionMatch = RUN_ACTION_PATTERN.exec(pathname);
  return actionMatch !== null && (actionMatch[2] === "generate" || actionMatch[2] === "retry");
}

/** No-op for admin/workbench. For demo, throws the same "Run not found" shape getRunOrThrow() already throws (mapped to 404 by errorStatusAndMessage) rather than a distinct 403 — a mismatched run shouldn't even confirm its own existence to a guesser. */
function assertRunOwnership(run: WorkflowRun, kind: WorkspaceKind, visitorId: string | undefined): void {
  if (kind !== "demo") return;
  if (run.visitorId !== visitorId) throw new Error(`Run not found: ${run.id}`);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
  const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.join(PUBLIC_DIR, relative);

  // Refuse to resolve outside PUBLIC_DIR (e.g. "..%2f..") — this server only
  // ever needs to serve the three known static files, not arbitrary disk reads.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(data);
  });
}

async function handleCreateRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  orchestrator: Orchestrator,
  ctx: { kind: WorkspaceKind; visitorId?: string }
): Promise<void> {
  const body = await readJsonBody(req);
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source) {
    sendJson(res, 400, { error: "source is required" });
    return;
  }
  const sourceType = inferSourceType(source, body.sourceType);
  const adhocResumeText =
    ctx.kind === "demo" && typeof body.resumeText === "string" && body.resumeText.trim()
      ? body.resumeText.trim()
      : undefined;
  const salaryLocationOverride =
    typeof body.salaryLocationOverride === "string" && body.salaryLocationOverride.trim()
      ? body.salaryLocationOverride.trim()
      : undefined;

  const run = orchestrator.createRun({
    sourceType,
    source,
    visitorId: ctx.visitorId,
    adhocResumeText,
    salaryLocationOverride,
  });
  try {
    const result = await orchestrator.analyze(run.id);
    sendJson(res, 201, { run: result.run, warnings: result.warnings });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err);
    sendJson(res, status, { error: message });
  }
}

function handleGetRunDetail(
  res: http.ServerResponse,
  orchestrator: Orchestrator,
  runId: string,
  ctx: { kind: WorkspaceKind; visitorId?: string }
): void {
  try {
    const run = orchestrator.getRun(runId);
    assertRunOwnership(run, ctx.kind, ctx.visitorId);
    const appSettings = orchestrator.getSettings();
    sendJson(res, 200, {
      run,
      vacancyReport: orchestrator.getVacancyReport(runId) ?? null,
      applicationPackageFiles: orchestrator.getApplicationPackageFiles(runId),
      trace: orchestrator.getTrace(runId),
      generationSettings: fileStore.readGenerationSettings(runId) ?? null,
      // Only the generation-default subset (never API keys/agent instructions) —
      // lets the generate form's checkboxes/limits reflect the admin-wide default
      // BEFORE a first generate() has ever run for this piece (which is the only
      // time generationSettings above exists) instead of always showing unchecked/
      // blank regardless of what's actually configured in Admin -> Settings.
      appSettingsDefaults: {
        includeCoverLetter: appSettings.defaultIncludeCoverLetter,
        humanizeStyle: appSettings.defaultHumanizeStyle,
        avoidOverfitting: appSettings.defaultAvoidOverfitting,
        limits: appSettings.defaultLimits,
      },
    });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err);
    sendJson(res, status, { error: message });
  }
}

function handleListRuns(
  res: http.ServerResponse,
  orchestrator: Orchestrator,
  ctx: { kind: WorkspaceKind; visitorId?: string }
): void {
  sendJson(res, 200, { runs: orchestrator.listRuns(ctx.kind === "demo" ? { visitorId: ctx.visitorId } : undefined) });
}

async function handleAction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  orchestrator: Orchestrator,
  runId: string,
  actionKey: ActionKey,
  ctx: { kind: WorkspaceKind; visitorId?: string }
): Promise<void> {
  try {
    assertRunOwnership(orchestrator.getRun(runId), ctx.kind, ctx.visitorId);
    if (actionKey === "generate") {
      const body = await readJsonBody(req);
      const result = await orchestrator.generate(runId, {
        limits: parseWriterLimitsOverride(body),
        manualQuestions: parseManualQuestions(body),
        includeCoverLetter: parseIncludeCoverLetter(body),
        guidanceById: parseGuidanceById(body),
        humanizeStyle: parseHumanizeStyle(body),
        avoidOverfitting: parseAvoidOverfitting(body),
      });
      sendJson(res, 200, { run: result.run, warnings: result.warnings });
      return;
    }
    if (actionKey === "retry") {
      const body = await readJsonBody(req);
      const result = await orchestrator.retryAnalysis(
        runId,
        parseSourceOverride(body),
        parseSalaryLocationOverride(body)
      );
      sendJson(res, 200, { run: result.run, warnings: result.warnings });
      return;
    }
    const result = await orchestrator[ACTIONS[actionKey]](runId);
    sendJson(res, 200, { run: result.run, warnings: result.warnings });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err);
    sendJson(res, status, { error: message });
  }
}

async function handleDeleteRun(
  res: http.ServerResponse,
  orchestrator: Orchestrator,
  runId: string,
  ctx: { kind: WorkspaceKind; visitorId?: string }
): Promise<void> {
  try {
    assertRunOwnership(orchestrator.getRun(runId), ctx.kind, ctx.visitorId);
    await orchestrator.deleteRun(runId);
    sendJson(res, 200, { deleted: true });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err);
    sendJson(res, status, { error: message });
  }
}

async function handleRegeneratePiece(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  orchestrator: Orchestrator,
  runId: string,
  pieceId: string,
  ctx: { kind: WorkspaceKind; visitorId?: string }
): Promise<void> {
  try {
    assertRunOwnership(orchestrator.getRun(runId), ctx.kind, ctx.visitorId);
    const body = await readJsonBody(req);
    const guidance = typeof body.guidance === "string" && body.guidance.trim() ? body.guidance.trim() : undefined;
    const positiveNumber = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
    const lengthOverride = {
      maxCharacters: positiveNumber(body.maxCharacters),
      coverLetterMinWords: positiveNumber(body.coverLetterMinWords),
      coverLetterMaxWords: positiveNumber(body.coverLetterMaxWords),
    };
    const result = await orchestrator.regeneratePiece(runId, pieceId, guidance, lengthOverride);
    sendJson(res, 200, { run: result.run, warnings: result.warnings });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err);
    sendJson(res, status, { error: message });
  }
}

async function handleAddQuestion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  orchestrator: Orchestrator,
  runId: string,
  ctx: { kind: WorkspaceKind; visitorId?: string }
): Promise<void> {
  try {
    assertRunOwnership(orchestrator.getRun(runId), ctx.kind, ctx.visitorId);
    const body = await readJsonBody(req);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) {
      sendJson(res, 400, { error: "question is required" });
      return;
    }
    const maxCharacters =
      typeof body.maxCharacters === "number" && Number.isFinite(body.maxCharacters) && body.maxCharacters > 0
        ? body.maxCharacters
        : undefined;
    const guidance = typeof body.guidance === "string" && body.guidance.trim() ? body.guidance.trim() : undefined;
    const result = await orchestrator.addQuestion(runId, { question, maxCharacters, guidance });
    sendJson(res, 200, { run: result.run, warnings: result.warnings });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err);
    sendJson(res, status, { error: message });
  }
}

function handleGetAdminSettings(res: http.ServerResponse, orchestrator: Orchestrator): void {
  sendJson(res, 200, maskSettings(orchestrator.getSettings()));
}

async function handleUpdateAdminSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  orchestrator: Orchestrator,
  kind: WorkspaceKind
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const updated = orchestrator.updateSettings(parseAdminSettingsUpdate(body));
    // Every cached workbench Orchestrator resolved its LLM fallback from the
    // ADMIN's settings via a thunk captured at construction time — that thunk
    // re-reads fresh each call, but nothing re-invokes it on an already-cached
    // instance unless told to. Without this, a workbench with no key of its
    // own keeps using a stale/revoked admin key until its cache entry happens
    // to be evicted (workbench reset/delete, or a server restart).
    if (kind === "admin") refreshWorkbenchLlmProviders();
    sendJson(res, 200, maskSettings(updated));
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err);
    sendJson(res, status, { error: message });
  }
}

const WORKBENCH_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/**
 * Refuses to reset/delete while ANY run on this workbench has a step in
 * flight — without this, an in-progress request keeps a reference to the
 * about-to-be-closed db/Orchestrator regardless of cache eviction, and its
 * next query throws against a closed SQLite handle (a confusing raw 500)
 * instead of a clean "try again" error; on Windows, rmSync can also fail
 * outright (EBUSY) against a directory whose db file is still open.
 */
function assertWorkbenchIdle(slug: string): void {
  const existing = peekOrchestratorForWorkspace(`workbench:${slug}`);
  if (existing?.hasActiveSteps()) {
    throw new HttpError(409, "A step is currently running for this workbench — wait for it to finish first.");
  }
}

/** Evicts the cached Orchestrator + closes its db handle + wipes its data directory — used by both reset and delete. */
function resetWorkbenchData(slug: string): void {
  const dataDir = workbenchDataDir(slug);
  evictOrchestratorForWorkspace(`workbench:${slug}`);
  closeDb(path.join(dataDir, "db", "app.sqlite3"));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function handleListWorkbenches(res: http.ServerResponse): void {
  sendJson(res, 200, {
    workbenches: listWorkbenches().map((w) => ({ slug: w.slug, displayName: w.displayName, createdAt: w.createdAt })),
  });
}

async function handleCreateWorkbench(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    if (!isWorkspacesEnabled()) {
      sendJson(res, 400, {
        error:
          "Workbenches require multi-workspace mode — set ADMIN_PASSWORD in .env and restart the server, or this workbench's link will never resolve.",
      });
      return;
    }
    const body = await readJsonBody(req);
    const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : slug;
    if (!WORKBENCH_SLUG_PATTERN.test(slug)) {
      sendJson(res, 400, { error: "slug must be 1-40 lowercase letters, numbers, or hyphens" });
      return;
    }
    if (!password) {
      sendJson(res, 400, { error: "password is required" });
      return;
    }
    if (getWorkbench(slug)) {
      sendJson(res, 400, { error: `A workbench named "${slug}" already exists` });
      return;
    }
    const { saltHex, hashHex } = hashWorkbenchPassword(password);
    const record = createWorkbench({ slug, displayName, passwordSaltHex: saltHex, passwordHashHex: hashHex });
    sendJson(res, 201, { slug: record.slug, displayName: record.displayName, createdAt: record.createdAt });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

async function handleUpdateWorkbench(req: http.IncomingMessage, res: http.ServerResponse, slug: string): Promise<void> {
  try {
    if (!getWorkbench(slug)) {
      sendJson(res, 404, { error: "Workbench not found" });
      return;
    }
    const body = await readJsonBody(req);
    if (typeof body.displayName === "string" && body.displayName.trim()) {
      renameWorkbench(slug, body.displayName.trim());
    }
    if (typeof body.password === "string" && body.password) {
      const { saltHex, hashHex } = hashWorkbenchPassword(body.password);
      updateWorkbenchPassword(slug, saltHex, hashHex);
      // Otherwise a browser already logged in under the OLD password keeps full
      // access for the rest of its session TTL, unaffected by the rotation.
      destroySessionsForWorkspace(`workbench:${slug}`);
    }
    sendJson(res, 200, { updated: true });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleResetWorkbench(res: http.ServerResponse, slug: string): void {
  try {
    if (!getWorkbench(slug)) {
      sendJson(res, 404, { error: "Workbench not found" });
      return;
    }
    assertWorkbenchIdle(slug);
    resetWorkbenchData(slug);
    sendJson(res, 200, { reset: true });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleDeleteWorkbench(res: http.ServerResponse, slug: string): void {
  try {
    if (!getWorkbench(slug)) {
      sendJson(res, 404, { error: "Workbench not found" });
      return;
    }
    assertWorkbenchIdle(slug);
    resetWorkbenchData(slug);
    deleteWorkbench(slug);
    sendJson(res, 200, { deleted: true });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleListResumes(res: http.ServerResponse): void {
  sendJson(res, 200, { resumes: listResumeFiles() });
}

/**
 * One endpoint, two shapes: `{fileName, contentBase64}` for a PDF upload,
 * `{name, text}` for a pasted-text resume — dispatched on which fields are
 * actually present, rather than adding a second route (which would collide
 * with `ADMIN_RESUME_ITEM_PATTERN`'s `:id` segment if given a literal
 * sub-path like `/resumes/text`).
 */
async function handleCreateResume(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    if (typeof body.text === "string") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const id = createResumeTextEntry(name, body.text);
      sendJson(res, 201, { id });
      return;
    }
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const base64Content = typeof body.contentBase64 === "string" ? body.contentBase64 : "";
    if (!fileName || !base64Content) {
      sendJson(res, 400, { error: "Either {name, text} or {fileName, contentBase64} is required" });
      return;
    }
    const id = saveResumeFile(fileName, Buffer.from(base64Content, "base64"));
    sendJson(res, 201, { id });
  } catch (err) {
    // 400 default: a plain Error here is a validation failure (wrong
    // extension, bad PDF signature, blank text, name collision) — but
    // readJsonBody() can also throw an HttpError (415 wrong content-type,
    // 413 too large), which must keep its own real status rather than being
    // flattened to 400 too.
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

async function handleUpdateResumeText(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    const updated = updateResumeTextEntry(id, text);
    sendJson(res, updated ? 200 : 404, { updated });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleDeleteResume(res: http.ServerResponse, id: string): void {
  try {
    const deleted = deleteResumeFile(id);
    sendJson(res, deleted ? 200 : 404, { deleted });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function parseQaBody(body: Record<string, unknown>): { question: string; answer: string } | undefined {
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  return question && answer ? { question, answer } : undefined;
}

function handleListAnswerExamples(res: http.ServerResponse): void {
  sendJson(res, 200, { entries: listAnswerExampleEntries() });
}

// Every handler below wraps its own try/catch (rather than relying solely on
// the outer dispatcher's catch-all) so a path-traversal id rejected by
// fsSafety.ts's resolveInsideDir() — a client mistake — reports 400, not the
// outer catch's generic 500 default; an HttpError from readJsonBody() still
// keeps its own real status regardless (see errorStatusAndMessage's doc comment).

async function handleCreateAnswerExample(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const qa = parseQaBody(body);
    if (!qa) {
      sendJson(res, 400, { error: "question and answer are required" });
      return;
    }
    const id = createAnswerExampleEntry(qa);
    sendJson(res, 201, { id });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

async function handleUpdateAnswerExample(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const qa = parseQaBody(body);
    if (!qa) {
      sendJson(res, 400, { error: "question and answer are required" });
      return;
    }
    const updated = updateAnswerExampleEntry(id, qa);
    sendJson(res, updated ? 200 : 404, { updated });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleDeleteAnswerExample(res: http.ServerResponse, id: string): void {
  try {
    const deleted = deleteAnswerExampleEntry(id);
    sendJson(res, deleted ? 200 : 404, { deleted });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleListCoverLetters(res: http.ServerResponse): void {
  sendJson(res, 200, { entries: listCoverLetterEntries() });
}

async function handleCreateCoverLetter(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    const id = createCoverLetterEntry(text);
    sendJson(res, 201, { id });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

async function handleUpdateCoverLetter(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    const updated = updateCoverLetterEntry(id, text);
    sendJson(res, updated ? 200 : 404, { updated });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleDeleteCoverLetter(res: http.ServerResponse, id: string): void {
  try {
    const deleted = deleteCoverLetterEntry(id);
    sendJson(res, deleted ? 200 : 404, { deleted });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleListCandidateNotes(res: http.ServerResponse): void {
  sendJson(res, 200, { entries: listCandidateNoteEntries() });
}

async function handleCreateCandidateNote(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    const id = createCandidateNoteEntry(text);
    sendJson(res, 201, { id });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

async function handleUpdateCandidateNote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    const updated = updateCandidateNoteEntry(id, text);
    sendJson(res, updated ? 200 : 404, { updated });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

function handleDeleteCandidateNote(res: http.ServerResponse, id: string): void {
  try {
    const deleted = deleteCandidateNoteEntry(id);
    sendJson(res, deleted ? 200 : 404, { deleted });
  } catch (err) {
    const { status, message } = errorStatusAndMessage(err, 400);
    sendJson(res, status, { error: message });
  }
}

const RUN_DETAIL_PATTERN = /^\/api\/runs\/([^/]+)$/;
const RUN_PIECE_REGENERATE_PATTERN = /^\/api\/runs\/([^/]+)\/pieces\/([^/]+)\/regenerate$/;
const RUN_PIECE_CREATE_PATTERN = /^\/api\/runs\/([^/]+)\/pieces$/;
const RUN_ACTION_PATTERN =
  /^\/api\/runs\/([^/]+)\/(approve|reject|generate|accept|reject-package|confirm-submit|retry)$/;

const ADMIN_SETTINGS_PATTERN = /^\/api\/admin\/settings$/;
const ADMIN_RESUMES_PATTERN = /^\/api\/admin\/resumes$/;
const ADMIN_RESUME_ITEM_PATTERN = /^\/api\/admin\/resumes\/([^/]+)$/;
const ADMIN_ANSWER_EXAMPLES_PATTERN = /^\/api\/admin\/answer-examples$/;
const ADMIN_ANSWER_EXAMPLE_ITEM_PATTERN = /^\/api\/admin\/answer-examples\/([^/]+)$/;
const ADMIN_COVER_LETTERS_PATTERN = /^\/api\/admin\/cover-letters$/;
const ADMIN_COVER_LETTER_ITEM_PATTERN = /^\/api\/admin\/cover-letters\/([^/]+)$/;
const ADMIN_CANDIDATE_NOTES_PATTERN = /^\/api\/admin\/candidate-notes$/;
const ADMIN_CANDIDATE_NOTE_ITEM_PATTERN = /^\/api\/admin\/candidate-notes\/([^/]+)$/;
const ADMIN_WORKBENCHES_PATTERN = /^\/api\/admin\/workbenches$/;
const ADMIN_WORKBENCH_ITEM_PATTERN = /^\/api\/admin\/workbenches\/([^/]+)$/;
const ADMIN_WORKBENCH_RESET_PATTERN = /^\/api\/admin\/workbenches\/([^/]+)\/reset$/;

/**
 * Everything that used to run against `url.pathname` and the module-level
 * `orchestrator` singleton now runs against the workspace-stripped `pathname`
 * and an explicit `orchestrator`/`ctx` pair — this function is called from
 * inside runWithWorkspace(descriptor, ...) (see the request handler below),
 * so every fileStore/resumeLibrary/etc call made transitively from any
 * handler here resolves against the right workspace's own data directory.
 */
async function dispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  orchestrator: Orchestrator,
  descriptor: WorkspaceDescriptor,
  visitorId: string | undefined
): Promise<void> {
  const ctx = { kind: descriptor.kind, visitorId };

  if (req.method === "GET" && pathname === "/") {
    return serveIndexHtml(res, descriptor);
  }

  // Demo is intentionally forceStubLlm/forceStubSearch at the Orchestrator level
  // (see orchestratorRegistry.ts) — this 403 is defense in depth on top of that,
  // so an anonymous visitor can never even reach the settings-mutation surface.
  if (descriptor.kind === "demo" && pathname.startsWith("/api/admin/")) {
    return sendJson(res, 403, { error: "Not available in the demo workspace" });
  }

  if (req.method === "GET" && pathname === "/api/runs") {
    return handleListRuns(res, orchestrator, ctx);
  }
  if (req.method === "POST" && pathname === "/api/runs") {
    return await handleCreateRun(req, res, orchestrator, ctx);
  }

  if (pathname === "/api/admin/settings") {
    if (req.method === "GET") return handleGetAdminSettings(res, orchestrator);
    if (req.method === "PUT") return await handleUpdateAdminSettings(req, res, orchestrator, descriptor.kind);
  }
  if (ADMIN_SETTINGS_PATTERN.test(pathname) && req.method !== "GET" && req.method !== "PUT") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  // Workbench management is admin-only — never reachable under /workbench/*
  // itself (no self-service creation/deletion of siblings).
  if (descriptor.kind === "admin") {
    if (ADMIN_WORKBENCHES_PATTERN.test(pathname)) {
      if (req.method === "GET") return handleListWorkbenches(res);
      if (req.method === "POST") return await handleCreateWorkbench(req, res);
      return sendJson(res, 405, { error: "Method not allowed" });
    }
    const workbenchResetMatch = ADMIN_WORKBENCH_RESET_PATTERN.exec(pathname);
    if (workbenchResetMatch && req.method === "POST") {
      return handleResetWorkbench(res, decodeRouteParam(workbenchResetMatch[1]!));
    }
    const workbenchItemMatch = ADMIN_WORKBENCH_ITEM_PATTERN.exec(pathname);
    if (workbenchItemMatch) {
      const slug = decodeRouteParam(workbenchItemMatch[1]!);
      if (req.method === "PUT") return await handleUpdateWorkbench(req, res, slug);
      if (req.method === "DELETE") return handleDeleteWorkbench(res, slug);
      return sendJson(res, 405, { error: "Method not allowed" });
    }
  }

  if (ADMIN_RESUMES_PATTERN.test(pathname)) {
    if (req.method === "GET") return handleListResumes(res);
    if (req.method === "POST") return await handleCreateResume(req, res);
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  const resumeItemMatch = ADMIN_RESUME_ITEM_PATTERN.exec(pathname);
  if (resumeItemMatch) {
    const resumeId = decodeRouteParam(resumeItemMatch[1]!);
    if (req.method === "PUT") return await handleUpdateResumeText(req, res, resumeId);
    if (req.method === "DELETE") return handleDeleteResume(res, resumeId);
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (ADMIN_ANSWER_EXAMPLES_PATTERN.test(pathname)) {
    if (req.method === "GET") return handleListAnswerExamples(res);
    if (req.method === "POST") return await handleCreateAnswerExample(req, res);
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  const answerExampleItemMatch = ADMIN_ANSWER_EXAMPLE_ITEM_PATTERN.exec(pathname);
  if (answerExampleItemMatch) {
    const id = decodeRouteParam(answerExampleItemMatch[1]!);
    if (req.method === "PUT") return await handleUpdateAnswerExample(req, res, id);
    if (req.method === "DELETE") return handleDeleteAnswerExample(res, id);
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (ADMIN_COVER_LETTERS_PATTERN.test(pathname)) {
    if (req.method === "GET") return handleListCoverLetters(res);
    if (req.method === "POST") return await handleCreateCoverLetter(req, res);
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  const coverLetterItemMatch = ADMIN_COVER_LETTER_ITEM_PATTERN.exec(pathname);
  if (coverLetterItemMatch) {
    const id = decodeRouteParam(coverLetterItemMatch[1]!);
    if (req.method === "PUT") return await handleUpdateCoverLetter(req, res, id);
    if (req.method === "DELETE") return handleDeleteCoverLetter(res, id);
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (ADMIN_CANDIDATE_NOTES_PATTERN.test(pathname)) {
    if (req.method === "GET") return handleListCandidateNotes(res);
    if (req.method === "POST") return await handleCreateCandidateNote(req, res);
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  const candidateNoteItemMatch = ADMIN_CANDIDATE_NOTE_ITEM_PATTERN.exec(pathname);
  if (candidateNoteItemMatch) {
    const id = decodeRouteParam(candidateNoteItemMatch[1]!);
    if (req.method === "PUT") return await handleUpdateCandidateNote(req, res, id);
    if (req.method === "DELETE") return handleDeleteCandidateNote(res, id);
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const pieceRegenerateMatch = RUN_PIECE_REGENERATE_PATTERN.exec(pathname);
  if (req.method === "POST" && pieceRegenerateMatch) {
    return await handleRegeneratePiece(req, res, orchestrator, pieceRegenerateMatch[1]!, pieceRegenerateMatch[2]!, ctx);
  }

  const pieceCreateMatch = RUN_PIECE_CREATE_PATTERN.exec(pathname);
  if (req.method === "POST" && pieceCreateMatch) {
    return await handleAddQuestion(req, res, orchestrator, pieceCreateMatch[1]!, ctx);
  }

  const actionMatch = RUN_ACTION_PATTERN.exec(pathname);
  if (req.method === "POST" && actionMatch) {
    return await handleAction(req, res, orchestrator, actionMatch[1]!, actionMatch[2] as ActionKey, ctx);
  }

  const detailMatch = RUN_DETAIL_PATTERN.exec(pathname);
  if (req.method === "GET" && detailMatch) {
    return handleGetRunDetail(res, orchestrator, detailMatch[1]!, ctx);
  }
  if (req.method === "DELETE" && detailMatch) {
    return await handleDeleteRun(res, orchestrator, detailMatch[1]!, ctx);
  }

  if (req.method === "GET") {
    return serveStatic(req, res, pathname);
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  void (async () => {
    try {
      const resolved = resolveWorkspace(url.pathname);
      if (resolved === "not-found") {
        // resolveWorkspace only recognizes "/", "/admin", "/demo", and
        // "/workbench/<slug>" — a static asset path (index.html's own
        // root-absolute "/app.js", "/styles.css", per-page modules, etc.,
        // see serveStatic's doc comment: these are workspace-agnostic and
        // root-absolute on purpose) legitimately falls through to
        // "not-found" here in multi-workspace mode. Try serving it as a
        // static file before giving up — without this, every asset 404s
        // once ADMIN_PASSWORD is set, since the served HTML always
        // references them by their bare root path regardless of which
        // workspace prefix loaded that HTML.
        if (req.method === "GET") return serveStatic(req, res, url.pathname);
        return sendJson(res, 404, { error: "Not found" });
      }
      if ("redirectTo" in resolved) {
        res.writeHead(302, { Location: resolved.redirectTo });
        res.end();
        return;
      }
      const { descriptor, rest } = resolved;

      // Every mutating route in this file is POST/PUT (DELETE can't be sent
      // cross-origin as a browser "simple" request in the first place, so it
      // doesn't need this) — checked once, up front, for every request
      // including /login — a cross-origin <form enctype="text/plain"> submit
      // must not be able to attempt a login any more than it can approve/
      // reject/etc, so this gate runs before login is special-cased below,
      // not after.
      if (req.method === "POST" || req.method === "PUT") {
        requireJsonContentType(req);
      }

      const clientIp = resolveClientIp(
        req.headers as Record<string, string | string[] | undefined>,
        env.trustedClientIpHeader,
        req.socket.remoteAddress
      );

      // Login/logout bypass the auth gate below entirely — that's the whole point.
      if (descriptor.requiresAuth && rest === "/login") {
        if (req.method === "GET") return serveLoginPage(res, descriptor);
        if (req.method === "POST") return await handleLogin(req, res, descriptor, clientIp);
        return sendJson(res, 405, { error: "Method not allowed" });
      }
      if (descriptor.requiresAuth && rest === "/logout" && req.method === "POST") {
        return handleLogout(req, res, descriptor);
      }

      const { authenticated, visitorId } = resolveRequestAuth(req, res, descriptor);
      if (!authenticated) {
        if (req.method === "GET" && rest === "/") return serveLoginPage(res, descriptor);
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      if (descriptor.kind === "demo" && isExpensiveActionRoute(req.method, rest) && !demoActionLimiter.tryConsume(clientIp)) {
        return sendJson(res, 429, {
          error: `Rate limit exceeded — try again in a bit (max ${env.demoRateLimitPerHour}/hour).`,
        });
      }
      if (
        // requiresAuth (not just kind === "admin") excludes legacy/single-instance
        // mode — LEGACY_DESCRIPTOR is also kind "admin" but requiresAuth: false,
        // and today's zero-limit local/no-auth usage must stay exactly as-is.
        descriptor.requiresAuth &&
        (descriptor.kind === "admin" || descriptor.kind === "workbench") &&
        isExpensiveActionRoute(req.method, rest) &&
        // Keyed by IP + workspace, not IP alone — same `ip + ":" + urlPrefix`
        // convention as the login limiter (see handleLogin) — so one
        // workbench's usage never eats into another's or the admin's own budget.
        !workspaceActionLimiter.tryConsume(`${clientIp}:${descriptor.urlPrefix}`)
      ) {
        return sendJson(res, 429, {
          error: `Rate limit exceeded — try again in a bit (max ${env.workspaceRateLimitPerHour}/hour).`,
        });
      }

      const orchestrator = getOrchestratorForWorkspace(descriptor);
      await runWithWorkspace(descriptor, () => dispatch(req, res, rest, orchestrator, descriptor, visitorId));
    } catch (err) {
      const { status, message } = errorStatusAndMessage(err);
      sendJson(res, status, { error: message });
    }
  })();
});

// Loopback by default, even with workspaces enabled — a fronting proxy (your
// own, or a PaaS's) decides what's actually reachable from the internet.
// Binding wider requires an explicit GUI_HOST=0.0.0.0 (see .env.example).
server.listen(PORT, HOST, () => {
  console.log(`RoleCase GUI running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (HOST === "0.0.0.0") {
    console.log("Bound to 0.0.0.0 — reachable from outside this machine. Make sure that's intended.");
  }
  // The rate limiters (demo actions, login attempts) trust env.trustedClientIpHeader
  // over the raw socket address — correct only if a fronting reverse proxy actually
  // SETS that header (overwriting any client-supplied value) rather than appending
  // to it or leaving it unset. This can't be verified from inside this process, so
  // it's surfaced here as an explicit reminder rather than silently assumed safe.
  if (isWorkspacesEnabled()) {
    console.log(
      `Rate limiting trusts the "${env.trustedClientIpHeader}" header for the real client IP — ` +
        `make sure your reverse proxy SETS it (e.g. nginx's "proxy_set_header X-Real-IP $remote_addr;"), ` +
        `not appends to a client-supplied value, or the per-IP limits can be bypassed or shared unfairly.`
    );
  }
});

// Demo retention purge sweep — scoped ONLY to the demo workspace's own
// Orchestrator/db, wrapped in runWithWorkspace so fileStore.deleteRunDir()
// (called transitively by purgeStaleRuns -> deleteRun) resolves demo's own
// data directory rather than falling back to the ambient default.
const demoDescriptor = demoDescriptorIfEnabled();
if (demoDescriptor) {
  const demoOrchestrator = getOrchestratorForWorkspace(demoDescriptor);
  const sweep = (): void => {
    void runWithWorkspace(demoDescriptor, () => demoOrchestrator.purgeStaleRuns(env.demoRunTtlHours)).catch((err) => {
      console.error("Demo retention purge sweep failed:", err);
    });
  };
  setInterval(sweep, 30 * 60_000).unref?.();
}
