// Unified progress events for the "Generate Summary" pipeline.
// Emitted from both /api/contributions and /api/summary, consumed by the web UI.

export const GENERATION_STEPS = [
  { id: "fetch-commit-list", label: "Fetch commit list", short: "Commits" },
  { id: "fetch-commit-diffs", label: "Fetch commit diffs", short: "Diffs" },
  { id: "fetch-pull-requests", label: "Fetch pull requests", short: "PRs" },
  { id: "backfill-pr-commits", label: "Backfill PR branch commits", short: "Backfill" },
  { id: "dedupe-and-group", label: "Dedupe & group", short: "Group" },
  { id: "summarize-groups", label: "Summarize groups", short: "Summarize" },
  { id: "create-overview", label: "Create overview", short: "Overview" },
] as const;

export type GenerationStepId = (typeof GENERATION_STEPS)[number]["id"];

export const TOTAL_GENERATION_STEPS = GENERATION_STEPS.length;

export function getStepIndex(id: GenerationStepId): number {
  // 1-based
  return GENERATION_STEPS.findIndex((s) => s.id === id) + 1;
}

export function getStepLabel(id: GenerationStepId): string {
  return GENERATION_STEPS.find((s) => s.id === id)!.label;
}

export interface GenerationProgress {
  stepId: GenerationStepId;
  stepIndex: number;
  totalSteps: number;
  stepLabel: string;
  /** Units completed within this step (0..total). */
  current: number;
  /** Total units in this step. 0 or 1 means no meaningful sub-progress — render indeterminate. */
  total: number;
  /** Human-readable sub-text, e.g. "repo 2/3 · vmockinc/foo · 45/386". */
  detail?: string;
  /** Set when the current unit was served from cache (summarize-groups only). */
  cached?: boolean;
  /** True once the step is fully done — used to advance the stepper. */
  stepDone?: boolean;
}

export function makeProgress(
  stepId: GenerationStepId,
  partial: Omit<
    GenerationProgress,
    "stepId" | "stepIndex" | "totalSteps" | "stepLabel"
  >,
): GenerationProgress {
  return {
    stepId,
    stepIndex: getStepIndex(stepId),
    totalSteps: TOTAL_GENERATION_STEPS,
    stepLabel: getStepLabel(stepId),
    ...partial,
  };
}
