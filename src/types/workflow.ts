import type { Recommendation } from "./analysis.js";
import type { VacancySourceType } from "./vacancy.js";

export const WorkflowState = {
  CREATED: "CREATED",
  ANALYZING: "ANALYZING",
  ANALYSIS_READY: "ANALYSIS_READY",
  REJECTED: "REJECTED",
  ANALYSIS_APPROVED: "ANALYSIS_APPROVED",
  GENERATING_PACKAGE: "GENERATING_PACKAGE",
  PACKAGE_READY: "PACKAGE_READY",
  PACKAGE_REJECTED: "PACKAGE_REJECTED",
  PACKAGE_ACCEPTED: "PACKAGE_ACCEPTED",
  DONE: "DONE",
  FAILED: "FAILED",
} as const;
export type WorkflowState = (typeof WorkflowState)[keyof typeof WorkflowState];

export interface WorkflowRun {
  id: string;
  state: WorkflowState;
  vacancySourceType: VacancySourceType;
  vacancySource: string;
  vacancyTitle: string | null;
  companyName: string | null;
  recommendation: Recommendation | null;
  packageIterationCount: number;
  regenerateAttemptCount: number;
  errorMessage: string | null;
  /** Which in-progress state the run was in when it hit FAILED, if any. */
  failedFromState: WorkflowState | null;
  /** Only ever set for demo runs (its anonymous session token doubles as this id) — null for admin/workbench. */
  visitorId: string | null;
  /** User-supplied country/location to benchmark salary research against, overriding the vacancy's own stated location. */
  salaryLocationOverride: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowCommand =
  | "analyze"
  | "approve"
  | "reject"
  | "generate"
  | "review"
  | "accept"
  | "reject_package"
  | "confirm_submit";
