// Runtime validation schemas shared between server routes and client persistence.
// Keep these in sync with the TypeScript types in src/core/github.ts + src/core/grouping.ts.

import { z } from "zod";

const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Must be YYYY-MM-DD" });

const RepoFullName = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, {
    message: 'Repo must be in "owner/repo" format',
  });

export const CommitSchema = z.object({
  sha: z.string().min(1),
  message: z.string(),
  author: z.string(),
  date: z.string(),
  repo: z.string(),
  diff: z.string().optional(),
  files: z.array(z.string()).optional(),
});

export const PullRequestSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["merged", "open", "closed"]),
  repo: z.string(),
  mergedAt: z.string().optional(),
  createdAt: z.string(),
  commits: z.array(z.string()),
  openedByOther: z.boolean().optional(),
});

export const CommitGroupSchema = z.object({
  type: z.enum(["pr", "orphan"]),
  label: z.string(),
  commits: z.array(CommitSchema),
  pr: PullRequestSchema.optional(),
});

const VALID_SCOPES = [
  "merged-prs",
  "open-prs",
  "closed-prs",
  "direct-commits",
  "fork-branches",
] as const;

export const ContributionsRequestSchema = z
  .object({
    repos: z.array(RepoFullName).min(1, { message: "`repos` must be non-empty" }),
    from: DateString,
    to: DateString,
    scope: z.array(z.enum(VALID_SCOPES)).optional(),
  })
  .refine((v) => new Date(v.from) <= new Date(v.to), {
    message: "`from` date must be before `to` date.",
    path: ["from"],
  });

export const SummaryRequestSchema = z.object({
  groups: z
    .array(CommitGroupSchema)
    .min(1, { message: "`groups` must be a non-empty array" }),
  from: DateString,
  to: DateString,
  repos: z.array(z.string()).min(1, { message: "`repos` must be non-empty" }),
  provider: z.enum(["claude", "codex", "cursor", "auto"]).optional(),
  model: z.string().optional(),
});

export const PersistedSettingsSchema = z.object({
  selectedRepos: z.array(z.string()),
  dateFrom: z.string(),
  dateTo: z.string(),
  scope: z.array(z.string()),
  llmProvider: z.string().optional(),
  llmModel: z.string().optional(),
});

// ── Atlas-workspace requests ───────────────────────────────────────────────

export const CreateLogRequestSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    rangeStart: DateString,
    rangeEnd: DateString,
    title: z.string().optional(),
    provider: z.enum(["claude", "codex", "cursor", "auto"]).optional(),
    model: z.string().optional(),
    scope: z.array(z.enum(VALID_SCOPES)).optional(),
  })
  .refine((v) => new Date(v.rangeStart) <= new Date(v.rangeEnd), {
    message: "`rangeStart` must be before `rangeEnd`",
    path: ["rangeStart"],
  });

export const CreateRollupRequestSchema = z
  .object({
    title: z.string().min(1),
    logIds: z.array(z.string().min(1)).min(1),
    provider: z.enum(["claude", "codex", "cursor", "auto"]).optional(),
    model: z.string().optional(),
  });

export const ChatRequestSchema = z.object({
  message: z.string().min(1, { message: "Message cannot be empty" }),
  provider: z.enum(["claude", "codex", "cursor", "auto"]).optional(),
  model: z.string().optional(),
});

export const ChatCommitRequestSchema = z.object({
  proposedSummary: z.string().min(1),
  userMessage: z.string().min(1),
  model: z.string().min(1),
});

export const ParentKindSchema = z.enum(["log", "rollup", "pr", "orphan"]);

export type ContributionsRequest = z.infer<typeof ContributionsRequestSchema>;
export type SummaryRequest = z.infer<typeof SummaryRequestSchema>;
export type PersistedSettings = z.infer<typeof PersistedSettingsSchema>;
export type CreateLogRequest = z.infer<typeof CreateLogRequestSchema>;
export type CreateRollupRequest = z.infer<typeof CreateRollupRequestSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatCommitRequest = z.infer<typeof ChatCommitRequestSchema>;
export type ParentKind = z.infer<typeof ParentKindSchema>;

/**
 * Format a Zod error into a single human-readable string for API responses.
 */
export function formatZodError(err: z.ZodError): string {
  const issues = err.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  return issues.join("; ");
}
