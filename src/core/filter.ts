// Diff filtering (lock files, generated code, etc.)
// TODO: Implement in Phase 3

const DEFAULT_EXCLUDE = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "*.lock",
  "*.gen.ts",
  "*.generated.*",
];

const DEPRIORITIZE = ["*.test.*", "*.spec.*", ".eslintrc", "tsconfig.json"];

const PRIORITIZE_DIRS = ["src/", "lib/", "app/"];

export interface FilterOptions {
  excludePatterns?: string[];
  maxFileSize?: number; // bytes
}

export function shouldExcludeFile(
  filePath: string,
  options: FilterOptions = {},
): boolean {
  const patterns = [...DEFAULT_EXCLUDE, ...(options.excludePatterns ?? [])];
  return patterns.some((pattern) => matchGlob(filePath, pattern));
}

export function getFilePriority(filePath: string): "high" | "normal" | "low" {
  if (DEPRIORITIZE.some((p) => matchGlob(filePath, p))) return "low";
  if (PRIORITIZE_DIRS.some((dir) => filePath.startsWith(dir))) return "high";
  return "normal";
}

function matchGlob(filePath: string, pattern: string): boolean {
  // TODO: Implement proper glob matching
  if (pattern.startsWith("*.")) {
    return filePath.endsWith(pattern.slice(1));
  }
  return filePath.includes(pattern);
}
