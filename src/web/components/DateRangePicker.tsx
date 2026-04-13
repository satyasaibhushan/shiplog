import { Calendar } from "lucide-react";
import { DATE_PRESETS } from "../types.ts";

interface Props {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}

function applyPreset(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString().split("T")[0]!,
    to: to.toISOString().split("T")[0]!,
  };
}

export function DateRangePicker({ from, to, onFromChange, onToChange }: Props) {
  return (
    <section>
      <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-3">
        <Calendar className="w-3 h-3" />
        Date Range
      </label>

      {/* Presets */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {DATE_PRESETS.map((p) => {
          const preset = applyPreset(p.days);
          const active = from === preset.from && to === preset.to;
          return (
            <button
              key={p.days}
              onClick={() => {
                onFromChange(preset.from);
                onToChange(preset.to);
              }}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                active
                  ? "bg-accent/15 text-accent border border-accent/30"
                  : "bg-neutral-800/50 text-neutral-400 border border-transparent hover:bg-neutral-800 hover:text-neutral-300"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Date inputs */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="text-[10px] text-neutral-500 mb-1 block">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => onFromChange(e.target.value)}
            className="w-full bg-neutral-800/60 border border-neutral-700/50 rounded-md px-2.5 py-1.5 text-xs text-neutral-200 font-mono focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
          />
        </div>
        <div>
          <span className="text-[10px] text-neutral-500 mb-1 block">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => onToChange(e.target.value)}
            className="w-full bg-neutral-800/60 border border-neutral-700/50 rounded-md px-2.5 py-1.5 text-xs text-neutral-200 font-mono focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
          />
        </div>
      </div>
    </section>
  );
}
