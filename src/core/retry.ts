// Retry with exponential backoff
// Phase 8: Polish & DX

/**
 * Categorised GitHub API error. We throw these from the `gh`-calling layer so
 * callers higher up the stack can make decisions based on `kind` rather than
 * string-matching error messages:
 *
 *   - `rate-limit` and `network` are transient — `withRetry` retries them.
 *     After retries exhaust, callers should treat them as fatal for the whole
 *     request (every subsequent call will hit the same wall).
 *   - `auth` is fatal immediately — retries won't help.
 *   - `not-found` is per-request (one bad repo shouldn't kill a multi-repo
 *     fetch), so higher layers log-and-continue.
 *   - `other` covers unknown non-zero exits from `gh`.
 */
export type GitHubErrorKind =
  | "rate-limit"
  | "auth"
  | "network"
  | "not-found"
  | "other";

export class GitHubApiError extends Error {
  readonly kind: GitHubErrorKind;
  readonly endpoint?: string;

  constructor(kind: GitHubErrorKind, message: string, endpoint?: string) {
    super(message);
    this.name = "GitHubApiError";
    this.kind = kind;
    this.endpoint = endpoint;
  }

  /**
   * True when the error affects every subsequent request, so higher layers
   * should abort the whole pipeline rather than continuing with the next repo.
   * Rate limits, auth failures, and network outages all fall into this bucket.
   */
  get isFatal(): boolean {
    return (
      this.kind === "rate-limit" ||
      this.kind === "auth" ||
      this.kind === "network"
    );
  }
}

/**
 * Narrow an unknown thrown value into a `GitHubApiError` when possible.
 * Convenience for catch blocks that need to branch on `err.isFatal`.
 */
export function asGitHubApiError(err: unknown): GitHubApiError | null {
  return err instanceof GitHubApiError ? err : null;
}

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms between retries, doubles each attempt (default: 1000) */
  baseDelay?: number;
  /** Called before each retry with the attempt number and error */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** Custom predicate to decide if an error is retryable (default: checks common transient errors) */
  isRetryable?: (error: Error) => boolean;
}

const DEFAULT_RETRYABLE_PATTERNS = [
  "rate limit",
  "abuse detection",
  "secondary rate",
  "502",
  "503",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "socket hang up",
  "fetch failed",
];

/**
 * Check if an error is retryable (transient network/rate-limit error).
 *
 * Typed `GitHubApiError`s short-circuit the string match: their `kind`
 * already tells us whether retrying is meaningful (rate-limit / network yes,
 * auth / not-found no).
 */
export function isRetryableError(error: Error): boolean {
  if (error instanceof GitHubApiError) {
    return error.kind === "rate-limit" || error.kind === "network";
  }
  const msg = error.message.toLowerCase();
  return DEFAULT_RETRYABLE_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

/**
 * Execute an async function with retry and exponential backoff.
 *
 * Retries on transient errors (rate limits, network issues, 5xx).
 * Uses jittered exponential backoff: delay = baseDelay * 2^attempt + random(0..500ms).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    onRetry,
    isRetryable = isRetryableError,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry if we've exhausted attempts or error isn't retryable
      if (attempt === maxRetries || !isRetryable(lastError)) {
        break;
      }

      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
      onRetry?.(attempt + 1, lastError, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError!;
}

/**
 * Check if the user has a working internet connection.
 * Pings GitHub's API endpoint.
 */
export async function checkConnectivity(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["gh", "api", "/rate_limit"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Log an unexpected error at warn level, scoped so the caller can be identified.
 * Use in catch blocks where swallowing silently would hide real problems.
 */
export function warnOnError(scope: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`  ⚠ ${scope}: ${message}`);
}

/**
 * Parse JSON or throw a richer error that includes the scope and a truncated
 * sample of the offending input. Useful when the raw input comes from an
 * external process whose output may be corrupt.
 */
export function parseJsonStrict<T>(raw: string, scope: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const sample = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON in ${scope}: ${cause}. Sample: ${sample}`);
  }
}

/**
 * Coordinate concurrent callers that would otherwise perform the same expensive
 * work in parallel. Given a key, the first caller runs `fn`; concurrent callers
 * for the same key await the in-flight promise and reuse its result. The entry
 * is cleared when the promise settles (success or failure) so later callers
 * can retry after a failure.
 */
export function createInflightDedup<T>() {
  const inflight = new Map<string, Promise<T>>();

  async function dedupe(key: string, fn: () => Promise<T>): Promise<{ value: T; dedupedFromInflight: boolean }> {
    const existing = inflight.get(key);
    if (existing) {
      const value = await existing;
      return { value, dedupedFromInflight: true };
    }
    const promise = fn();
    inflight.set(key, promise);
    try {
      const value = await promise;
      return { value, dedupedFromInflight: false };
    } finally {
      inflight.delete(key);
    }
  }

  return { dedupe, size: () => inflight.size };
}

/**
 * Get the current GitHub API rate limit status.
 */
export async function getRateLimit(): Promise<{
  remaining: number;
  limit: number;
  resetAt: Date;
} | null> {
  try {
    const proc = Bun.spawn(["gh", "api", "/rate_limit"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    const data = parseJsonStrict<{
      rate: { remaining: number; limit: number; reset: number };
    }>(stdout, "getRateLimit");
    return {
      remaining: data.rate.remaining,
      limit: data.rate.limit,
      resetAt: new Date(data.rate.reset * 1000),
    };
  } catch (err) {
    warnOnError("getRateLimit", err);
    return null;
  }
}
