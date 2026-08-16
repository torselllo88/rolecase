import { getDb } from "../persistence/db.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";

export function createOrchestrator(): Orchestrator {
  return new Orchestrator(getDb());
}
