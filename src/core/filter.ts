// Diff filtering (lock files, generated code, etc.)
// Phase 3: Diff Filtering

import type { Commit } from "./github.ts";

// ── Default Patterns ──

const DEFAULT_EXCLUDE = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "*.lock",
  "*.gen.ts",
  "*.generated.*",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.snap",
];

const BINARY_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".webm",
  ".ogg",
  ".wav",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
];

const DEPRIORITIZE = [
  "*.test.*",
  "*.spec.*",
  "*.test.ts",
  "*.test.tsx",
  "*.test.js",
  "*.spec.ts",
  "*.spec.tsx",
  "*.spec.js",
  "__tests__/*",
  "__snapshots__/*",
  ".eslintrc",
  ".eslintrc.*",
  "eslint.config.*",
  "tsconfig.json",
  "tsconfig.*.json",
  ".prettierrc",
  ".prettierrc.*",
  "prettier.config.*",
  "jest.config.*",
  "vitest.config.*",
  ".gitignore",
  ".editorconfig",
  "Dockerfile",
  "docker-compose.*",
];

const PRIORITIZE_DIRS = ["src/", "lib/", "app/", "packages/", "components/"];

// ── Types ──

export interface FilterOptions {
  excludePatterns?: string[];
  maxFileSize?: number; // bytes — not used for diff text, but for future use
}

export type FilePriority = "high" | "normal" | "low";

export interface FilteredDiff {
  /** Filtered diff text with excluded files removed */
  diff: string;
  /** Files that passed the filter */
  includedFiles: string[];
  /** Files that were excluded */
  excludedFiles: string[];
  /** File priority categorization */
  priorities: Map<string, FilePriority>;
}

// ── Glob Matching ──

/**
 * Match a file path against a glob pattern.
 *
 * Supports:
 *   - `*` matches any characters within a single path segment (no `/`)
 *   - `**` matches any characters across path segments (including `/`)
 *   - `?` matches a single character
 *   - Exact matches (e.g. `package-lock.json`)
 *
 * If the pattern contains no `/`, it matches against the filename only.
 * Otherwise it matches against the full path.
 */
export function matchGlob(filePath: string, pattern: string): boolean {
  const fileName = filePath.split("/").pop() ?? filePath;

  // Match against filename only if pattern has no path separator
  const target = pattern.includes("/") ? filePath : fileName;

  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars (not * or ?)
    .replace(/\*\*/g, "\0") // Temporarily replace **
    .replace(/\*/g, "[^/]*") // * matches within one segment
    .replace(/\0/g, ".*") // ** matches across segments
    .replace(/\?/g, "[^/]"); // ? matches single char

  return new RegExp(`^${regexStr}$`).test(target);
}

// ── Public API ──

/**
 * Check if a file should be excluded from LLM input.
 */
export function shouldExcludeFile(
  filePath: string,
  options: FilterOptions = {},
): boolean {
  const patterns = [...DEFAULT_EXCLUDE, ...(options.excludePatterns ?? [])];

  // Check glob patterns
  if (patterns.some((pattern) => matchGlob(filePath, pattern))) return true;

  // Check binary extensions
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
  if (BINARY_EXTENSIONS.includes(ext)) return true;

  return false;
}

/**
 * Get the priority of a file for LLM summarization.
 *   - "high": source code in key directories
 *   - "normal": other files
 *   - "low": tests, config files
 */
export function getFilePriority(filePath: string): FilePriority {
  if (DEPRIORITIZE.some((p) => matchGlob(filePath, p))) return "low";
  if (PRIORITIZE_DIRS.some((dir) => filePath.startsWith(dir))) return "high";
  return "normal";
}

/**
 * Split a combined diff string into per-file sections.
 * Expects the format produced by fetchCommitDetail:
 *   `--- a/file\n+++ b/file\n<hunks>` separated by `\n\n`
 */
export function splitDiffByFile(
  diff: string,
): Array<{ filePath: string; content: string }> {
  if (!diff || !diff.trim()) return [];

  const sections: Array<{ filePath: string; content: string }> = [];
  const pattern = /^--- a\/(.+)$/gm;
  const indices: Array<{ filePath: string; start: number }> = [];

  let match;
  while ((match = pattern.exec(diff)) !== null) {
    indices.push({ filePath: match[1]!, start: match.index });
  }

  for (let i = 0; i < indices.length; i++) {
    const start = indices[i]!.start;
    const end = i + 1 < indices.length ? indices[i + 1]!.start : diff.length;
    sections.push({
      filePath: indices[i]!.filePath,
      content: diff.slice(start, end).trim(),
    });
  }

  return sections;
}

/**
 * Filter a commit's diff, removing excluded files and categorizing priorities.
 * Returns a new Commit with the filtered diff and updated file list.
 */
export function filterCommitDiff(
  commit: Commit,
  options: FilterOptions = {},
): { commit: Commit; filterResult: FilteredDiff } {
  const includedFiles: string[] = [];
  const excludedFiles: string[] = [];
  const priorities = new Map<string, FilePriority>();

  // If no diff, return as-is
  if (!commit.diff) {
    return {
      commit,
      filterResult: {
        diff: "",
        includedFiles: commit.files ?? [],
        excludedFiles: [],
        priorities,
      },
    };
  }

  // Split diff into file sections
  const sections = splitDiffByFile(commit.diff);
  const filteredSections: string[] = [];

  for (const section of sections) {
    if (shouldExcludeFile(section.filePath, options)) {
      excludedFiles.push(section.filePath);
      continue;
    }

    includedFiles.push(section.filePath);
    priorities.set(section.filePath, getFilePriority(section.filePath));
    filteredSections.push(section.content);
  }

  // Also categorize files that are in the file list but not in the diff
  for (const file of commit.files ?? []) {
    if (
      !includedFiles.includes(file) &&
      !excludedFiles.includes(file)
    ) {
      if (shouldExcludeFile(file, options)) {
        excludedFiles.push(file);
      } else {
        includedFiles.push(file);
        priorities.set(file, getFilePriority(file));
      }
    }
  }

  const filteredDiff = filteredSections.join("\n\n");

  return {
    commit: {
      ...commit,
      diff: filteredDiff,
      files: includedFiles,
    },
    filterResult: {
      diff: filteredDiff,
      includedFiles,
      excludedFiles,
      priorities,
    },
  };
}

/**
 * Build an ordered diff string that puts high-priority files first,
 * then normal, then low. Useful before sending to LLM.
 */
export function buildPrioritizedDiff(
  commit: Commit,
  options: FilterOptions = {},
): string {
  if (!commit.diff) return "";

  const sections = splitDiffByFile(commit.diff);

  const high: string[] = [];
  const normal: string[] = [];
  const low: string[] = [];

  for (const section of sections) {
    if (shouldExcludeFile(section.filePath, options)) continue;

    const priority = getFilePriority(section.filePath);
    switch (priority) {
      case "high":
        high.push(section.content);
        break;
      case "low":
        low.push(section.content);
        break;
      default:
        normal.push(section.content);
    }
  }

  // Low-priority files get a compact summary instead of full diff
  const lowSummary =
    low.length > 0
      ? `\n\n[Also changed ${low.length} test/config file(s) — diffs omitted for brevity]`
      : "";

  return [...high, ...normal].join("\n\n") + lowSummary;
}
