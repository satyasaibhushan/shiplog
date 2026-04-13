// Retry with exponential backoff
// Phase 8: Polish & DX

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
 */
export function isRetryableError(error: Error): boolean {
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

    const data = JSON.parse(stdout);
    return {
      remaining: data.rate.remaining,
      limit: data.rate.limit,
      resetAt: new Date(data.rate.reset * 1000),
    };
  } catch {
    return null;
  }
}
