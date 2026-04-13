import { Filter, Check } from "lucide-react";
import { SCOPE_OPTIONS } from "../types.ts";

interface Props {
  scope: string[];
  onChange: (scope: string[]) => void;
}

export function ScopeFilter({ scope, onChange }: Props) {
  const toggle = (value: string) => {
    onChange(
      scope.includes(value)
        ? scope.filter((s) => s !== value)
        : [...scope, value]
    );
  };

  return (
    <section>
      <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-3">
        <Filter className="w-3 h-3" />
        Scope
      </label>
      <div className="space-y-0.5">
        {SCOPE_OPTIONS.map((opt) => {
          const active = scope.includes(opt.value);
          return (
            <button
              key={opt.value}
              onClick={() => toggle(opt.value)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors group ${
                active
                  ? "bg-accent/8 text-neutral-200"
                  : "text-neutral-500 hover:bg-neutral-800/50 hover:text-neutral-400"
              }`}
            >
              <div
                className={`w-3.5 h-3.5 rounded flex-shrink-0 flex items-center justify-center border transition-colors ${
                  active
                    ? "bg-accent border-accent"
                    : "border-neutral-600 group-hover:border-neutral-500"
                }`}
              >
                {active && <Check className="w-2.5 h-2.5 text-neutral-950" strokeWidth={3} />}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium">{opt.label}</div>
                <div className="text-[10px] text-neutral-600 leading-tight">
                  {opt.description}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
