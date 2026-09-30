import { createHash } from "crypto";
/** Canonical object-key ordering; callers sort arrays when order is not semantic. */
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJSON(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(stableJSON(value)).digest("hex");
const pending = new Map<string, Promise<unknown>>();
/** Coalesce identical concurrent requests in one process. */
export function singleFlight<T>(key: string, action: () => Promise<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const result = action().finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}
