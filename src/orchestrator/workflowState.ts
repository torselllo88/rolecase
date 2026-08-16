import { WorkflowState } from "../types/workflow.js";

export type WorkflowCommandName =
  | "analyze"
  | "approve"
  | "reject"
  | "generate"
  | "accept"
  | "reject_package"
  | "confirm_submit";

/**
 * Each command has the state(s) it starts from, the "in-progress" state it
 * commits immediately (so a crash mid-step is visible on `status` rather than
 * looking like nothing happened — see FAILED handling below), and the state it
 * commits on success.
 */
interface CommandTransition {
  fromStates: WorkflowState[];
  inProgressState: WorkflowState;
  successState: WorkflowState;
}

const TRANSITIONS: Record<WorkflowCommandName, CommandTransition> = {
  analyze: {
    fromStates: [WorkflowState.CREATED],
    inProgressState: WorkflowState.ANALYZING,
    successState: WorkflowState.ANALYSIS_READY,
  },
  approve: {
    fromStates: [WorkflowState.ANALYSIS_READY],
    inProgressState: WorkflowState.ANALYSIS_READY,
    successState: WorkflowState.ANALYSIS_APPROVED,
  },
  reject: {
    fromStates: [WorkflowState.ANALYSIS_READY],
    inProgressState: WorkflowState.ANALYSIS_READY,
    successState: WorkflowState.REJECTED,
  },
  generate: {
    fromStates: [WorkflowState.ANALYSIS_APPROVED, WorkflowState.PACKAGE_REJECTED],
    inProgressState: WorkflowState.GENERATING_PACKAGE,
    successState: WorkflowState.PACKAGE_READY,
  },
  accept: {
    fromStates: [WorkflowState.PACKAGE_READY],
    inProgressState: WorkflowState.PACKAGE_READY,
    successState: WorkflowState.PACKAGE_ACCEPTED,
  },
  reject_package: {
    fromStates: [WorkflowState.PACKAGE_READY],
    inProgressState: WorkflowState.PACKAGE_READY,
    successState: WorkflowState.PACKAGE_REJECTED,
  },
  // No browser automation to prepare/verify a real submission — this is a
  // plain manual "I've submitted this myself" gate straight from acceptance.
  confirm_submit: {
    fromStates: [WorkflowState.PACKAGE_ACCEPTED],
    inProgressState: WorkflowState.PACKAGE_ACCEPTED,
    successState: WorkflowState.DONE,
  },
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly command: WorkflowCommandName,
    public readonly currentState: WorkflowState
  ) {
    super(`Cannot run "${command}" from state ${currentState}`);
  }
}

/**
 * For actions that gate on workflow state without being state-transitioning
 * steps themselves (e.g. regeneratePiece/addQuestion — see orchestrator.ts) —
 * distinct from IllegalTransitionError only because those actions aren't
 * WorkflowCommandNames. Callers treat both the same way (see server.ts's
 * errorStatusAndMessage): a 409, not a 500 — this is an expected, recoverable
 * conflict, not a crash.
 */
export class InvalidActionStateError extends Error {
  constructor(
    public readonly action: string,
    public readonly currentState: WorkflowState
  ) {
    super(`Cannot run "${action}" from state ${currentState}`);
  }
}

/**
 * Returns the in-progress state to commit before running the step (or the
 * success state directly for gate-only commands). Throws IllegalTransitionError
 * if the command isn't valid from currentState — covers a fresh start, a safe
 * re-run of a step that crashed after committing its in-progress state but
 * before committing success, and an explicit retry from FAILED for the same
 * command that failed (tracked via failedFromState).
 */
export function resolveEntryState(
  command: WorkflowCommandName,
  currentState: WorkflowState,
  failedFromState: WorkflowState | null
): WorkflowState {
  const transition = TRANSITIONS[command];

  if (transition.fromStates.includes(currentState)) return transition.inProgressState;
  if (currentState === transition.inProgressState) return transition.inProgressState;
  if (currentState === WorkflowState.FAILED && failedFromState === transition.inProgressState) {
    return transition.inProgressState;
  }

  throw new IllegalTransitionError(command, currentState);
}

export function successStateFor(command: WorkflowCommandName): WorkflowState {
  return TRANSITIONS[command].successState;
}

export function inProgressStateFor(command: WorkflowCommandName): WorkflowState {
  return TRANSITIONS[command].inProgressState;
}
