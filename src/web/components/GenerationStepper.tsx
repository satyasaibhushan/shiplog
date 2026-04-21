import { Fragment } from "react";
import { Check } from "lucide-react";
import {
  GENERATION_STEPS,
  TOTAL_GENERATION_STEPS,
  type GenerationProgress,
} from "../types.ts";
import type { Theme } from "../theme.ts";

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
  t,
  progress,
}: {
  t: Theme;
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
          <p
            className="text-[10px] uppercase tracking-[0.15em] font-medium"
            style={{ color: t.textFaint }}
          >
            Step {currentIndex} / {TOTAL_GENERATION_STEPS}
          </p>
          <h3
            className="text-base font-semibold tracking-tight mt-0.5"
            style={{ color: t.text }}
          >
            {activeStep.label}
          </h3>
        </div>
        <span
          className="text-sm font-mono tabular-nums"
          style={{ color: t.textDim }}
        >
          {indeterminate ? "…" : `${Math.round(percent)}%`}
        </span>
      </div>

      {/* Row 1: segmented bar (dots + active bar + connectors) */}
      <div className="flex items-center">
        {steps.map((step, i) => (
          <Fragment key={`seg-${step.id}`}>
            {step.status === "active" ? (
              <ActiveBar
                t={t}
                label={step.label}
                percent={percent}
                indeterminate={indeterminate}
              />
            ) : (
              <Dot t={t} step={step} />
            )}
            {i < steps.length - 1 && (
              <Connector t={t} done={step.status === "done"} />
            )}
          </Fragment>
        ))}
      </div>

      {/* Row 2: labels aligned to Row 1 */}
      <div className="flex items-start mt-2">
        {steps.map((step, i) => (
          <Fragment key={`lbl-${step.id}`}>
            <Label t={t} step={step} />
            {i < steps.length - 1 && (
              <span className={`flex-shrink-0 ${CONN_W}`} aria-hidden />
            )}
          </Fragment>
        ))}
      </div>

      {/* Active step detail */}
      <p
        className="mt-4 text-xs truncate h-4"
        style={{ color: t.textFaint }}
      >
        {active?.detail ?? ""}
      </p>
    </div>
  );
}

function ActiveBar({
  t,
  label,
  percent,
  indeterminate,
}: {
  t: Theme;
  label: string;
  percent: number;
  indeterminate: boolean;
}) {
  return (
    <div
      className="flex-1 min-w-0 h-2 rounded-full overflow-hidden relative"
      style={{ background: t.surface2 }}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
    >
      {indeterminate ? (
        <div
          className="h-full w-1/3 rounded-full animate-progress-indeterminate"
          style={{ background: t.accent, opacity: 0.8 }}
        />
      ) : (
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%`, background: t.accent }}
        />
      )}
    </div>
  );
}

function Dot({ t, step }: { t: Theme; step: Step }) {
  return (
    <div
      className={`flex-shrink-0 ${CELL_W} flex items-center justify-center`}
      title={`Step ${step.index}: ${step.label}`}
      aria-label={`Step ${step.index}: ${step.label} — ${step.status}`}
    >
      {step.status === "done" ? (
        <div
          className="w-5 h-5 rounded-full flex items-center justify-center"
          style={{
            background: `${t.accent}26`,
            border: `1px solid ${t.accent}99`,
          }}
        >
          <Check
            className="w-3 h-3"
            strokeWidth={3}
            style={{ color: t.accent }}
          />
        </div>
      ) : (
        <div
          className="w-2 h-2 rounded-full"
          style={{ background: t.textFaint }}
        />
      )}
    </div>
  );
}

function Connector({ t, done }: { t: Theme; done: boolean }) {
  return (
    <span
      className={`flex-shrink-0 ${CONN_W} h-px`}
      style={{ background: done ? `${t.accent}99` : t.border }}
      aria-hidden
    />
  );
}

function Label({ t, step }: { t: Theme; step: Step }) {
  const color =
    step.status === "done"
      ? t.textDim
      : step.status === "active"
      ? t.text
      : t.textFaint;
  const fontWeight = step.status === "active" ? 600 : 400;

  // Active cell grows to match the expanded bar above it.
  const width =
    step.status === "active" ? "flex-1 min-w-0" : `flex-shrink-0 ${CELL_W}`;

  return (
    <div
      className={`${width} ${LABEL_CLS} truncate`}
      style={{ color, fontWeight }}
    >
      {step.short}
    </div>
  );
}

function progressPercent(p: GenerationProgress | null): number {
  if (!p) return 0;
  if (p.total <= 0) return 0;
  return Math.min(100, (p.current / p.total) * 100);
}
