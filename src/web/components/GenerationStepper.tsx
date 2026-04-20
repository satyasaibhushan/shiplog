import { Fragment } from "react";
import { Check } from "lucide-react";
import {
  GENERATION_STEPS,
  TOTAL_GENERATION_STEPS,
  type GenerationProgress,
} from "../types.ts";

type StepStatus = "done" | "active" | "pending";
type Step = (typeof GENERATION_STEPS)[number] & {
  index: number;
  status: StepStatus;
};

// Fixed width for non-active cells so the label row lines up pixel-for-pixel
// with the dot row above it. Wide enough to fit the longest short label
// ("Summarize") at the chosen font size without truncation.
const CELL_W = "w-20"; // 5rem / 80px
const CONN_W = "w-2"; // connector + spacer width
const LABEL_CLS = "text-[10px] text-center leading-tight";

export function GenerationStepper({
  progress,
}: {
  progress: GenerationProgress | null;
}) {
  const currentIndex = progress?.stepIndex ?? 1;
  const active = progress ?? null;
  const percent = progressPercent(active);
  const indeterminate = active
    ? active.total <= 0 || (active.total === 1 && !active.stepDone)
    : true;

  const steps: Step[] = GENERATION_STEPS.map((step, i) => {
    const index = i + 1;
    let status: StepStatus;
    if (index < currentIndex) status = "done";
    else if (index === currentIndex) status = "active";
    else status = "pending";
    return { ...step, index, status };
  });

  const activeStep = steps[currentIndex - 1]!;

  return (
    <div className="w-full max-w-2xl animate-fade-in">
      {/* Header: full label + counter */}
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 font-medium">
            Step {currentIndex} / {TOTAL_GENERATION_STEPS}
          </p>
          <h3 className="text-base font-semibold text-neutral-100 tracking-tight mt-0.5">
            {activeStep.label}
          </h3>
        </div>
        <span className="text-sm font-mono text-neutral-400 tabular-nums">
          {indeterminate ? "…" : `${Math.round(percent)}%`}
        </span>
      </div>

      {/* Row 1: segmented bar (dots + active bar + connectors) */}
      <div className="flex items-center">
        {steps.map((step, i) => (
          <Fragment key={`seg-${step.id}`}>
            {step.status === "active" ? (
              <ActiveBar
                label={step.label}
                percent={percent}
                indeterminate={indeterminate}
              />
            ) : (
              <Dot step={step} />
            )}
            {i < steps.length - 1 && (
              <Connector done={step.status === "done"} />
            )}
          </Fragment>
        ))}
      </div>

      {/* Row 2: labels aligned to Row 1 */}
      <div className="flex items-start mt-2">
        {steps.map((step, i) => (
          <Fragment key={`lbl-${step.id}`}>
            <Label step={step} />
            {i < steps.length - 1 && (
              <span className={`flex-shrink-0 ${CONN_W}`} aria-hidden />
            )}
          </Fragment>
        ))}
      </div>

      {/* Active step detail */}
      <p className="mt-4 text-xs text-neutral-500 truncate h-4">
        {active?.detail ?? ""}
      </p>
    </div>
  );
}

function ActiveBar({
  label,
  percent,
  indeterminate,
}: {
  label: string;
  percent: number;
  indeterminate: boolean;
}) {
  return (
    <div
      className="flex-1 min-w-0 h-2 bg-neutral-800/80 rounded-full overflow-hidden relative"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
    >
      {indeterminate ? (
        <div className="h-full w-1/3 bg-accent/80 rounded-full animate-progress-indeterminate" />
      ) : (
        <div
          className="h-full bg-accent rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}

function Dot({ step }: { step: Step }) {
  return (
    <div
      className={`flex-shrink-0 ${CELL_W} flex items-center justify-center`}
      title={`Step ${step.index}: ${step.label}`}
      aria-label={`Step ${step.index}: ${step.label} — ${step.status}`}
    >
      {step.status === "done" ? (
        <div className="w-5 h-5 rounded-full bg-accent/15 border border-accent/60 flex items-center justify-center">
          <Check className="w-3 h-3 text-accent" strokeWidth={3} />
        </div>
      ) : (
        <div className="w-2 h-2 rounded-full bg-neutral-700" />
      )}
    </div>
  );
}

function Connector({ done }: { done: boolean }) {
  return (
    <span
      className={`flex-shrink-0 ${CONN_W} h-px ${
        done ? "bg-accent/60" : "bg-neutral-800"
      }`}
      aria-hidden
    />
  );
}

function Label({ step }: { step: Step }) {
  const color =
    step.status === "done"
      ? "text-neutral-400"
      : step.status === "active"
      ? "text-neutral-100 font-semibold"
      : "text-neutral-600";

  // Active cell grows to match the expanded bar above it.
  const width =
    step.status === "active" ? "flex-1 min-w-0" : `flex-shrink-0 ${CELL_W}`;

  return (
    <div className={`${width} ${LABEL_CLS} ${color} truncate`}>
      {step.short}
    </div>
  );
}

function progressPercent(p: GenerationProgress | null): number {
  if (!p) return 0;
  if (p.total <= 0) return 0;
  return Math.min(100, (p.current / p.total) * 100);
}
