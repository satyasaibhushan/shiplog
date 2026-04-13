import { Cpu, ChevronDown, Lock } from "lucide-react";
import { useState } from "react";
import type { StatusCheck } from "../hooks/useShiplog.ts";

interface Props {
  provider: string;
  model: string;
  onProviderChange: (p: string) => void;
  onModelChange: (m: string) => void;
  claudeStatus?: StatusCheck;
  codexStatus?: StatusCheck;
}

const PROVIDERS = [
  {
    id: "claude",
    label: "Claude Code",
    icon: "✦",
    models: [
      { id: "sonnet", label: "Sonnet 4.6", description: "Best value — fast, smart" },
      { id: "haiku", label: "Haiku 4.5", description: "Fastest — lightweight tasks" },
      { id: "opus", label: "Opus 4.6", description: "Most capable — complex analysis" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    icon: "◈",
    models: [
      { id: "o4-mini", label: "o4-mini", description: "Fast, efficient" },
      { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "Balanced" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: "Most capable" },
    ],
  },
] as const;

export function ModelSelector({
  provider,
  model,
  onProviderChange,
  onModelChange,
  claudeStatus,
  codexStatus,
}: Props) {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  const statusMap: Record<string, StatusCheck | undefined> = {
    claude: claudeStatus,
    codex: codexStatus,
  };

  return (
    <section>
      <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-3">
        <Cpu className="w-3 h-3" />
        AI Model
      </label>

      <div className="space-y-1.5">
        {PROVIDERS.map((p) => {
          const isAvailable = statusMap[p.id]?.ok ?? false;
          const isSelected = provider === p.id;
          const currentModel = isSelected
            ? p.models.find((m) => m.id === model) ?? p.models[0]
            : p.models[0];

          return (
            <div key={p.id} className="relative">
              {/* Provider card */}
              <div
                className={`rounded-lg border transition-all ${
                  !isAvailable
                    ? "opacity-40 pointer-events-none border-neutral-800/40 bg-neutral-900/20"
                    : isSelected
                      ? "border-accent/30 bg-accent/5"
                      : "border-neutral-800/40 bg-neutral-900/30 hover:border-neutral-700/50 cursor-pointer"
                }`}
              >
                {/* Header — click to select provider */}
                <button
                  onClick={() => {
                    if (!isAvailable) return;
                    onProviderChange(p.id);
                    if (!isSelected) {
                      onModelChange(p.models[0].id);
                    }
                  }}
                  disabled={!isAvailable}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left"
                >
                  {/* Radio */}
                  <div
                    className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      isSelected
                        ? "border-accent"
                        : "border-neutral-600"
                    }`}
                  >
                    {isSelected && (
                      <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                    )}
                  </div>

                  <span className="text-sm font-medium flex-shrink-0">
                    {p.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span
                      className={`text-xs font-semibold ${
                        isSelected ? "text-neutral-200" : "text-neutral-400"
                      }`}
                    >
                      {p.label}
                    </span>
                  </div>

                  {!isAvailable && (
                    <Lock className="w-3 h-3 text-neutral-600 flex-shrink-0" />
                  )}

                  {/* Model dropdown trigger */}
                  {isAvailable && isSelected && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenDropdown(openDropdown === p.id ? null : p.id);
                      }}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-800/60 text-[10px] font-mono text-accent hover:bg-neutral-800 transition-colors"
                    >
                      {currentModel?.label}
                      <ChevronDown className="w-2.5 h-2.5" />
                    </button>
                  )}
                </button>

                {/* Not available hint */}
                {!isAvailable && (
                  <div className="px-3 pb-2 -mt-0.5">
                    <p className="text-[10px] text-neutral-600">
                      {statusMap[p.id]?.detail ?? "Not installed"}
                    </p>
                  </div>
                )}
              </div>

              {/* Model dropdown */}
              {openDropdown === p.id && isSelected && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setOpenDropdown(null)}
                  />
                  <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-neutral-900 border border-neutral-700/50 rounded-lg shadow-xl overflow-hidden">
                    {p.models.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => {
                          onModelChange(m.id);
                          setOpenDropdown(null);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                          model === m.id
                            ? "bg-accent/10 text-neutral-200"
                            : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-300"
                        }`}
                      >
                        <div
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            model === m.id ? "bg-accent" : "bg-neutral-700"
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-medium font-mono">
                            {m.label}
                          </div>
                          <div className="text-[10px] text-neutral-500">
                            {m.description}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
