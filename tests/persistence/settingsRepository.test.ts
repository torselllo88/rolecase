import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { SettingsRepository } from "../../src/persistence/settingsRepository.js";

describe("SettingsRepository", () => {
  let db: DatabaseSync;
  let repo: SettingsRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new SettingsRepository(db);
  });

  it("returns an all-null/empty default row before anything is ever written", () => {
    const settings = repo.getSettings();

    expect(settings.defaultLimits).toEqual({});
    expect(settings.defaultIncludeCoverLetter).toBeNull();
    expect(settings.llmProvider).toBeNull();
    expect(settings.openRouterApiKey).toBeNull();
  });

  it("persists a partial update without wiping fields it didn't touch", () => {
    repo.updateSettings({ llmProvider: "openrouter", openRouterApiKey: "sk-test-1", openRouterModel: "gpt-test" });

    const afterFirstWrite = repo.updateSettings({ defaultHumanizeStyle: true });

    expect(afterFirstWrite.llmProvider).toBe("openrouter");
    expect(afterFirstWrite.openRouterApiKey).toBe("sk-test-1");
    expect(afterFirstWrite.openRouterModel).toBe("gpt-test");
    expect(afterFirstWrite.defaultHumanizeStyle).toBe(true);
  });

  it("merges defaultLimits rather than replacing the whole object", () => {
    repo.updateSettings({ defaultLimits: { coverLetterMinWords: 100 } });
    const after = repo.updateSettings({ defaultLimits: { coverLetterMaxWords: 300 } });

    expect(after.defaultLimits).toEqual({ coverLetterMinWords: 100, coverLetterMaxWords: 300 });
  });

  it("only clears an API key when its explicit clear flag is set, not on every update", () => {
    repo.updateSettings({ openRouterApiKey: "sk-test-1" });
    const untouched = repo.updateSettings({ defaultHumanizeStyle: true });
    expect(untouched.openRouterApiKey).toBe("sk-test-1");

    const cleared = repo.updateSettings({ clearOpenRouterKey: true });
    expect(cleared.openRouterApiKey).toBeNull();
  });

  it("distinguishes an omitted field (leave alone) from an explicit null (clear it)", () => {
    repo.updateSettings({ llmProvider: "openrouter" });
    const leftAlone = repo.updateSettings({ defaultHumanizeStyle: true });
    expect(leftAlone.llmProvider).toBe("openrouter");

    const cleared = repo.updateSettings({ llmProvider: null });
    expect(cleared.llmProvider).toBeNull();
  });

  it("persists across repository instances sharing the same db (the row survives, not just in-memory state)", () => {
    repo.updateSettings({ azureEndpoint: "https://example.openai.azure.com" });

    const secondRepo = new SettingsRepository(db);
    expect(secondRepo.getSettings().azureEndpoint).toBe("https://example.openai.azure.com");
  });
});
