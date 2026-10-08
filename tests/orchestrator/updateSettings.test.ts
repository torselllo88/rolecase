import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";

describe("Orchestrator.updateSettings", () => {
  let db: DatabaseSync;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    db = createInMemoryDb();
    orchestrator = new Orchestrator(db);
  });

  it("rejects picking a provider that isn't actually configured, and never persists the attempt", () => {
    expect(() => orchestrator.updateSettings({ llmProvider: "openrouter", clearOpenRouterKey: true })).toThrow(
      /openrouter is selected but not configured/i
    );

    // The whole point: a rejected save must not have written anything —
    // a fresh Orchestrator sharing the same DB (simulating a server
    // restart) must NOT also throw just from being constructed.
    expect(() => new Orchestrator(db)).not.toThrow();
    expect(orchestrator.getSettings().llmProvider).toBeNull();
  });

  it("still allows an update that doesn't touch the provider even when the provider is unconfigured", () => {
    // Sanity check that the validation doesn't over-fire for unrelated fields.
    const updated = orchestrator.updateSettings({ defaultHumanizeStyle: true });
    expect(updated.defaultHumanizeStyle).toBe(true);
  });

  it("enables OpenRouter from just an API key when no .env model is set (built-in default model)", () => {
    const updated = orchestrator.updateSettings({ llmProvider: "openrouter", openRouterApiKey: "sk-test-key" });
    expect(updated.llmProvider).toBe("openrouter");
  });

  it("enables Azure entirely from GUI settings, including the API version, with no .env", () => {
    const updated = orchestrator.updateSettings({
      llmProvider: "azure",
      azureApiKey: "azure-test-key",
      azureEndpoint: "https://example.openai.azure.com",
      azureApiVersion: "2024-08-01-preview",
      azureDeployment: "test-deployment",
    });
    expect(updated.llmProvider).toBe("azure");
  });

  it("persists and applies a valid provider selection", () => {
    const updated = orchestrator.updateSettings({
      llmProvider: "openrouter",
      openRouterApiKey: "sk-test-key",
      openRouterModel: "test-model",
    });

    expect(updated.llmProvider).toBe("openrouter");
    expect(updated.openRouterApiKey).toBe("sk-test-key");
    // A fresh Orchestrator against the same DB picks up the same, still-valid settings.
    expect(() => new Orchestrator(db)).not.toThrow();
  });
});
