import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface Props {
  diff: string;
}

export function DiffViewer({ diff }: Props) {
  const [copied, setCopied] = useState(false);

  const lines = diff.split("\n");

  const copyDiff = async () => {
    await navigator.clipboard.writeText(diff);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative bg-neutral-950/60 rounded-lg border border-neutral-800/40 overflow-hidden">
      {/* Copy button */}
      <button
        onClick={copyDiff}
        className="absolute top-2 right-2 p-1 rounded text-neutral-600 hover:text-neutral-400 hover:bg-neutral-800/60 transition-colors z-10"
        title="Copy diff"
      >
        {copied ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <Copy className="w-3 h-3" />
        )}
      </button>

      {/* Diff content */}
      <div className="overflow-x-auto p-3 text-[11px] leading-[1.6] font-mono">
        {lines.map((line, i) => (
          <div key={i} className={`whitespace-pre ${getLineClass(line)}`}>
            <span className="inline-block w-8 text-right mr-3 select-none text-neutral-700 text-[10px]">
              {i + 1}
            </span>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function getLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-amber-400/80 font-semibold";
  }
  if (line.startsWith("+")) {
    return "text-emerald-400/90 bg-emerald-500/[0.06]";
  }
  if (line.startsWith("-")) {
    return "text-red-400/90 bg-red-500/[0.06]";
  }
  if (line.startsWith("@@")) {
    return "text-cyan-400/70";
  }
  if (line.startsWith("...")) {
    return "text-neutral-600 italic";
  }
  return "text-neutral-500";
}
