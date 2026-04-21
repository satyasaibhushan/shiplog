// Theme tokens ported from the Claude Design prototype.
// Two font families only: Inter (UI) + JetBrains Mono (code, meta, numbers).

export interface Theme {
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentInk: string;
  compiled: string;
  compiledDim: string;
  gap: string;
  merged: string;
  mergedBg: string;
  open: string;
  openBg: string;
  closed: string;
  orphan: string;
  orphanBg: string;
  added: string;
  removed: string;
  sha: string;
  overlay: string;
}

export type ThemeName = "dark" | "light";

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    bg: "#0b0b0c",
    surface: "#141416",
    surface2: "#1b1b1e",
    surface3: "#232328",
    border: "#242428",
    borderStrong: "#36363c",
    text: "#ededed",
    textDim: "#a1a1a6",
    textFaint: "#6b6b72",
    accent: "#e6ff6b",
    accentInk: "#0a0a0a",
    compiled: "#e6ff6b",
    compiledDim: "#4a5a1e",
    gap: "#1f1f23",
    merged: "#c084fc",
    mergedBg: "rgba(192,132,252,0.12)",
    open: "#4ade80",
    openBg: "rgba(74,222,128,0.12)",
    closed: "#f87171",
    orphan: "#c28a3a",
    orphanBg: "rgba(194,138,58,0.14)",
    added: "#4ade80",
    removed: "#f87171",
    sha: "#c084fc",
    overlay: "rgba(0,0,0,0.72)",
  },
  light: {
    bg: "#fafaf7",
    surface: "#ffffff",
    surface2: "#f4f3ee",
    surface3: "#ecebe3",
    border: "#e6e5de",
    borderStrong: "#c9c7bd",
    text: "#0e0e0c",
    textDim: "#595752",
    textFaint: "#8e8c85",
    accent: "#1b1b1b",
    accentInk: "#faf8ef",
    compiled: "#1b1b1b",
    compiledDim: "#b5b2a5",
    gap: "#ecebe3",
    merged: "#7c3aed",
    mergedBg: "rgba(124,58,237,0.10)",
    open: "#059669",
    openBg: "rgba(5,150,105,0.10)",
    closed: "#dc2626",
    orphan: "#a16207",
    orphanBg: "rgba(161,98,7,0.10)",
    added: "#16a34a",
    removed: "#dc2626",
    sha: "#7c3aed",
    overlay: "rgba(30,28,22,0.4)",
  },
};

export const FONT_SANS =
  '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
export const FONT_MONO =
  '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

export function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${n}`;
}

export function fmtRange([from, to]: [string, string]): string {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const sameYear = fromDate.getFullYear() === toDate.getFullYear();
  const opts: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  const f = fromDate.toLocaleDateString("en-US", opts);
  const t = toDate.toLocaleDateString("en-US", opts);
  return `${f} – ${t}`;
}

export function dayIdx(iso: string, epoch: string): number {
  return Math.floor(
    (new Date(iso).getTime() - new Date(epoch).getTime()) / 86400000,
  );
}

export function fmtRelative(iso: string | undefined | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const now = Date.now();
  const diffMs = Math.max(0, now - then);
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function fmtDateLabel(iso: string | number | undefined | null): string {
  if (iso == null) return "—";
  const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Map common GitHub language names to canonical language dot colors.
const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Go: "#00add8",
  Python: "#3572a5",
  Rust: "#dea584",
  Ruby: "#701516",
  Java: "#b07219",
  Swift: "#f05138",
  "C++": "#f34b7d",
  Kotlin: "#a97bff",
  MDX: "#f1e05a",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Shell: "#89e051",
  Vue: "#41b883",
  Dart: "#00B4AB",
};

export function langColor(lang: string | undefined): string {
  if (!lang) return "#6b6b72";
  return LANG_COLORS[lang] ?? "#6b6b72";
}
