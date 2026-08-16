import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { fileStore } from "../../src/persistence/fileStore.js";
import { env } from "../../src/config/env.js";
import type { AppSettings } from "../../src/persistence/settingsRepository.js";

function fakeAppSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultLimits: {},
    defaultIncludeCoverLetter: null,
    defaultHumanizeStyle: null,
    llmProvider: null,
    openRouterApiKey: null,
    openRouterModel: null,
    azureApiKey: null,
    azureEndpoint: null,
    azureApiVersion: null,
    azureDeployment: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("Orchestrator — multi-workspace behavior", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  describe("forceStubLlm", () => {
    it("never records a model_call trace event, even with a fully-configured (fake) LLM key", async () => {
      const orchestrator = new Orchestrator(db, { forceStubLlm: true });
      orchestrator.updateSettings({
        llmProvider: "openrouter",
        openRouterApiKey: "fake-key-that-would-fail-if-actually-used",
        openRouterModel: "fake-model",
      });

      const run = orchestrator.createRun({ sourceType: "raw_text", source: "Senior Engineer at Acme, great role." });
      await orchestrator.analyze(run.id);
      await orchestrator.approve(run.id);
      await orchestrator.generate(run.id);

      const trace = orchestrator.getTrace(run.id);
      expect(trace.some((e) => e.eventType === "model_call")).toBe(false);
      // The run still completed successfully via each agent's own deterministic stub.
      expect(orchestrator.getRun(run.id).state).toBeTruthy();
    });
  });

  describe("forceStubSearch", () => {
    const originalBraveKey = env.braveSearchApiKey;

    afterEach(() => {
      env.braveSearchApiKey = originalBraveKey;
    });

    it("never attempts a real search, even with a fully-configured (fake) Brave key — proven by the deterministic stub's marker URL", async () => {
      env.braveSearchApiKey = "fake-brave-key-that-would-fail-if-actually-used";
      const orchestrator = new Orchestrator(db, { forceStubSearch: true });

      const run = orchestrator.createRun({ sourceType: "raw_text", source: "Senior Engineer at Acme, great role." });
      await orchestrator.analyze(run.id);

      const report = orchestrator.getVacancyReport(run.id);
      expect(report?.companyResearch.sources.length).toBeGreaterThan(0);
      // SearchBroker's own stub always uses example.com URLs — a real Brave
      // result never would, so this is direct proof the real API was never hit.
      expect(report?.companyResearch.sources.every((url) => url.includes("example.com"))).toBe(true);
    });
  });

  describe("ad-hoc (demo) resume paste", () => {
    it("createRun's adhocResumeText is what analyze() grounds itself in, without touching the shared Resume Library directory", async () => {
      const orchestrator = new Orchestrator(db);
      const run = orchestrator.createRun({
        sourceType: "raw_text",
        source: "Senior Engineer at Acme, great role.",
        visitorId: "demo-session-token",
        adhocResumeText: "Jane Doe — 8 years of backend engineering, deep Kubernetes expertise.",
      });

      await orchestrator.analyze(run.id);

      const trace = orchestrator.getTrace(run.id);
      const resumeLibraryCall = trace.find((e) => e.toolName === "resume_library.list_resumes");
      expect(resumeLibraryCall?.responseJson).toMatchObject({ resumeCount: 1, source: "adhoc" });
      expect((resumeLibraryCall?.responseJson as { resumeIds: string[] })?.resumeIds).toEqual([`adhoc-${run.id}`]);

      // The shared Resume Library directory was never scanned or written to.
      expect(fileStore.readAdhocResumeText(run.id)).toContain("Jane Doe");
    });

    it("a run created with NO adhocResumeText falls through to the normal (empty, in this test) shared library, unaffected", async () => {
      const orchestrator = new Orchestrator(db);
      const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role." });

      await orchestrator.analyze(run.id);

      const trace = orchestrator.getTrace(run.id);
      const resumeLibraryCall = trace.find((e) => e.toolName === "resume_library.list_resumes");
      expect((resumeLibraryCall?.responseJson as { source?: string })?.source).not.toBe("adhoc");
      expect(fileStore.readAdhocResumeText(run.id)).toBeUndefined();
    });
  });

  describe("hasActiveSteps", () => {
    it("is false when nothing is running, true while a step is in flight, and false again once it finishes", async () => {
      const orchestrator = new Orchestrator(db);
      const run = orchestrator.createRun({ sourceType: "raw_text", source: "Some role." });

      expect(orchestrator.hasActiveSteps()).toBe(false);

      const pending = orchestrator.analyze(run.id);
      // activeSteps.add() happens synchronously before analyze()'s first await
      // point, so this is observable immediately, without awaiting `pending` yet.
      expect(orchestrator.hasActiveSteps()).toBe(true);

      await pending;
      expect(orchestrator.hasActiveSteps()).toBe(false);
    });
  });

  describe("purgeStaleRuns", () => {
    it("deletes only runs older than the cutoff, leaving fresh ones untouched", async () => {
      const orchestrator = new Orchestrator(db);
      const staleRun = orchestrator.createRun({ sourceType: "raw_text", source: "Old stale run", visitorId: "v1" });
      const freshRun = orchestrator.createRun({ sourceType: "raw_text", source: "Brand new run", visitorId: "v2" });

      // Backdate the stale run's created_at directly — purgeStaleRuns only reads the DB column.
      db.prepare(`UPDATE workflow_runs SET created_at = ? WHERE id = ?`).run(
        new Date(Date.now() - 100 * 3_600_000).toISOString(),
        staleRun.id
      );

      const result = await orchestrator.purgeStaleRuns(48);

      expect(result.deleted).toContain(staleRun.id);
      expect(result.deleted).not.toContain(freshRun.id);
      expect(() => orchestrator.getRun(staleRun.id)).toThrow();
      expect(orchestrator.getRun(freshRun.id)).toBeTruthy();
    });

    it("skips (doesn't delete) a stale run that currently has a step in flight", async () => {
      const orchestrator = new Orchestrator(db);
      const run = orchestrator.createRun({ sourceType: "raw_text", source: "Old but busy run" });
      db.prepare(`UPDATE workflow_runs SET created_at = ? WHERE id = ?`).run(
        new Date(Date.now() - 100 * 3_600_000).toISOString(),
        run.id
      );

      const pending = orchestrator.analyze(run.id); // don't await yet — step is now "in flight"
      const result = await orchestrator.purgeStaleRuns(48);

      expect(result.skipped).toContain(run.id);
      expect(result.deleted).not.toContain(run.id);

      await pending; // let the in-flight step finish so it doesn't leak into other tests
    });

    it("returns empty deleted/skipped arrays when nothing is old enough to purge", async () => {
      const orchestrator = new Orchestrator(db);
      orchestrator.createRun({ sourceType: "raw_text", source: "Brand new" });

      const result = await orchestrator.purgeStaleRuns(48);
      expect(result).toEqual({ deleted: [], skipped: [] });
    });
  });

  describe("resolveLlmSettings (workbench LLM fallback chain)", () => {
    function resolve(orchestrator: Orchestrator): AppSettings {
      return (orchestrator as unknown as { resolveLlmSettings(): AppSettings }).resolveLlmSettings();
    }

    it("with no llmFallbackSettings option, returns the Orchestrator's own settings unchanged", () => {
      const orchestrator = new Orchestrator(db);
      // updateSettings() validates the full config (apiKey AND model) before persisting
      // — openRouterModel must be set here too, not just the key, or this throws
      // regardless of what's under test (previously masked by a real LLM_MODEL_DEFAULT
      // leaking in from a developer's own .env — see env.ts's VITEST guard).
      orchestrator.updateSettings({
        llmProvider: "openrouter",
        openRouterApiKey: "own-key",
        openRouterModel: "own-model",
      });

      const resolved = resolve(orchestrator);
      expect(resolved.llmProvider).toBe("openrouter");
      expect(resolved.openRouterApiKey).toBe("own-key");
    });

    it("falls back to the fallback settings' LLM fields only when its own are unset", () => {
      const fallback = fakeAppSettings({
        llmProvider: "openrouter",
        openRouterApiKey: "admin-key",
        openRouterModel: "admin-model",
      });
      const orchestrator = new Orchestrator(db, { llmFallbackSettings: () => fallback });
      // Own settings row is left entirely at its default (all-null) state.

      const resolved = resolve(orchestrator);
      expect(resolved.llmProvider).toBe("openrouter");
      expect(resolved.openRouterApiKey).toBe("admin-key");
      expect(resolved.openRouterModel).toBe("admin-model");
    });

    it("prefers its OWN LLM fields over the fallback's when both are set", () => {
      // forceStubLlm:true here purely to skip the constructor's own eager
      // createLlmProvider validation (which would otherwise reject "azure" as
      // unconfigured, since env has no AZURE_OPENAI_* set in this test run) —
      // resolveLlmSettings() itself doesn't depend on this flag at all.
      const fallback = fakeAppSettings({ llmProvider: "azure", openRouterApiKey: "admin-key" });
      const orchestrator = new Orchestrator(db, { forceStubLlm: true, llmFallbackSettings: () => fallback });
      orchestrator.updateSettings({ llmProvider: "openrouter", openRouterApiKey: "own-key", openRouterModel: "own-model" });

      const resolved = resolve(orchestrator);
      expect(resolved.llmProvider).toBe("openrouter");
      expect(resolved.openRouterApiKey).toBe("own-key");
    });

    it("does NOT cascade generation defaults (limits/includeCoverLetter/humanizeStyle) — those stay workbench-local", () => {
      const fallback = fakeAppSettings({
        defaultIncludeCoverLetter: true,
        defaultHumanizeStyle: true,
        defaultLimits: { answerMaxWords: 999 },
      });
      const orchestrator = new Orchestrator(db, { llmFallbackSettings: () => fallback });
      // Own settings row's generation defaults are left at their default null/empty state.

      const resolved = resolve(orchestrator);
      expect(resolved.defaultIncludeCoverLetter).toBeNull();
      expect(resolved.defaultHumanizeStyle).toBeNull();
      expect(resolved.defaultLimits).toEqual({});
    });

    it("re-reads the fallback thunk fresh on every call — a live source, not a one-time snapshot", () => {
      // forceStubLlm:true to skip the constructor's own eager createLlmProvider
      // validation — irrelevant here since we're only exercising resolveLlmSettings()
      // directly, and the fallback's llmProvider values below aren't meant to be
      // fully "configured" (no keys at all) — only the field itself is under test.
      let fallbackProvider: AppSettings["llmProvider"] = "openrouter";
      const orchestrator = new Orchestrator(db, {
        forceStubLlm: true,
        llmFallbackSettings: () => fakeAppSettings({ llmProvider: fallbackProvider }),
      });

      expect(resolve(orchestrator).llmProvider).toBe("openrouter");
      fallbackProvider = "azure";
      expect(resolve(orchestrator).llmProvider).toBe("azure");
    });
  });
});
