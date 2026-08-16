import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { RunRepository } from "../../src/persistence/runRepository.js";

describe("RunRepository — visitor_id (demo per-visitor isolation)", () => {
  let db: DatabaseSync;
  let repo: RunRepository;

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new RunRepository(db);
  });

  it("createRun persists visitorId when given, and null when omitted (admin/workbench's call sites)", () => {
    const withVisitor = repo.createRun({ vacancySourceType: "raw_text", vacancySource: "vacancy A", visitorId: "session-abc" });
    const withoutVisitor = repo.createRun({ vacancySourceType: "raw_text", vacancySource: "vacancy B" });

    expect(withVisitor.visitorId).toBe("session-abc");
    expect(withoutVisitor.visitorId).toBeNull();
  });

  it("listRuns({visitorId}) returns only that visitor's runs", () => {
    const alice = repo.createRun({ vacancySourceType: "raw_text", vacancySource: "alice's vacancy", visitorId: "alice" });
    repo.createRun({ vacancySourceType: "raw_text", vacancySource: "bob's vacancy", visitorId: "bob" });
    repo.createRun({ vacancySourceType: "raw_text", vacancySource: "admin's vacancy" });

    const aliceRuns = repo.listRuns({ visitorId: "alice" });
    expect(aliceRuns).toHaveLength(1);
    expect(aliceRuns[0]!.id).toBe(alice.id);
  });

  it("listRuns() with no filter (admin/workbench's call sites) returns every run regardless of visitorId — unchanged from before this feature", () => {
    repo.createRun({ vacancySourceType: "raw_text", vacancySource: "alice's vacancy", visitorId: "alice" });
    repo.createRun({ vacancySourceType: "raw_text", vacancySource: "admin's vacancy" });

    expect(repo.listRuns()).toHaveLength(2);
  });

  it("listRuns({state}) with no visitorId still filters by state only, byte-identical to the pre-feature query shape", () => {
    const created = repo.createRun({ vacancySourceType: "raw_text", vacancySource: "some vacancy" });
    repo.createRun({ vacancySourceType: "raw_text", vacancySource: "another vacancy", visitorId: "someone" });

    const results = repo.listRuns({ state: created.state });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.state === created.state)).toBe(true);
  });

  it("listRuns can combine state AND visitorId filters", () => {
    const aliceRun = repo.createRun({ vacancySourceType: "raw_text", vacancySource: "alice's vacancy", visitorId: "alice" });
    repo.createRun({ vacancySourceType: "raw_text", vacancySource: "bob's vacancy", visitorId: "bob" });

    const results = repo.listRuns({ state: aliceRun.state, visitorId: "alice" });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(aliceRun.id);
  });

  it("a mismatched visitorId returns an empty list rather than throwing (used by ownership checks to distinguish 'not yours' from a crash)", () => {
    repo.createRun({ vacancySourceType: "raw_text", vacancySource: "alice's vacancy", visitorId: "alice" });
    expect(repo.listRuns({ visitorId: "someone-else-entirely" })).toEqual([]);
  });

  describe("listRunIdsCreatedBefore", () => {
    it("returns ids of runs created before the given cutoff, and excludes ones created after", () => {
      const old = repo.createRun({ vacancySourceType: "raw_text", vacancySource: "old vacancy" });
      const cutoff = new Date(Date.now() + 60_000).toISOString(); // 1 minute in the future
      const fresh = repo.createRun({ vacancySourceType: "raw_text", vacancySource: "fresh vacancy" });

      const staleIds = repo.listRunIdsCreatedBefore(cutoff);
      expect(staleIds).toContain(old.id);
      expect(staleIds).toContain(fresh.id); // fresh was also created before the future cutoff
    });

    it("excludes runs created after the cutoff", () => {
      const cutoffInThePast = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      const run = repo.createRun({ vacancySourceType: "raw_text", vacancySource: "just created" });

      expect(repo.listRunIdsCreatedBefore(cutoffInThePast)).not.toContain(run.id);
    });

    it("returns an empty array when nothing is old enough", () => {
      repo.createRun({ vacancySourceType: "raw_text", vacancySource: "brand new" });
      const cutoffInThePast = new Date(Date.now() - 60_000).toISOString();
      expect(repo.listRunIdsCreatedBefore(cutoffInThePast)).toEqual([]);
    });
  });
});
