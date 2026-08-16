import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  resolveEntryState,
  successStateFor,
} from "../../src/orchestrator/workflowState.js";
import { WorkflowState } from "../../src/types/workflow.js";

describe("workflowState", () => {
  it("allows analyze from CREATED", () => {
    expect(resolveEntryState("analyze", WorkflowState.CREATED, null)).toBe(WorkflowState.ANALYZING);
  });

  it("rejects approve from CREATED", () => {
    expect(() => resolveEntryState("approve", WorkflowState.CREATED, null)).toThrow(
      IllegalTransitionError
    );
  });

  it("allows a safe re-run from the in-progress state itself (crash recovery)", () => {
    expect(resolveEntryState("analyze", WorkflowState.ANALYZING, null)).toBe(WorkflowState.ANALYZING);
  });

  it("allows retry from FAILED only for the command that actually failed", () => {
    expect(resolveEntryState("analyze", WorkflowState.FAILED, WorkflowState.ANALYZING)).toBe(
      WorkflowState.ANALYZING
    );
    expect(() =>
      resolveEntryState("generate", WorkflowState.FAILED, WorkflowState.ANALYZING)
    ).toThrow(IllegalTransitionError);
  });

  it("allows generate from both ANALYSIS_APPROVED and PACKAGE_REJECTED (regenerate)", () => {
    expect(resolveEntryState("generate", WorkflowState.ANALYSIS_APPROVED, null)).toBe(
      WorkflowState.GENERATING_PACKAGE
    );
    expect(resolveEntryState("generate", WorkflowState.PACKAGE_REJECTED, null)).toBe(
      WorkflowState.GENERATING_PACKAGE
    );
  });

  it("maps each command to its success state", () => {
    expect(successStateFor("analyze")).toBe(WorkflowState.ANALYSIS_READY);
    expect(successStateFor("confirm_submit")).toBe(WorkflowState.DONE);
  });
});
