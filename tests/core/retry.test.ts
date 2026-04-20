import { describe, expect, it } from "bun:test";
import {
  createInflightDedup,
  parseJsonStrict,
} from "../../src/core/retry.ts";

describe("parseJsonStrict", () => {
  it("parses valid JSON", () => {
    expect(parseJsonStrict<{ a: number }>('{"a":1}', "test")).toEqual({ a: 1 });
  });

  it("throws a scoped error with a sample for bad JSON", () => {
    try {
      parseJsonStrict("not json at all", "unit-test");
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("unit-test");
      expect(msg).toContain("not json");
    }
  });
});

describe("createInflightDedup", () => {
  it("runs fn once for concurrent callers with the same key", async () => {
    const dedup = createInflightDedup<string>();
    let invocations = 0;

    const slow = async () => {
      invocations++;
      await new Promise((r) => setTimeout(r, 20));
      return "value";
    };

    const [a, b, c] = await Promise.all([
      dedup.dedupe("k", slow),
      dedup.dedupe("k", slow),
      dedup.dedupe("k", slow),
    ]);

    expect(invocations).toBe(1);
    expect(a.value).toBe("value");
    expect(b.value).toBe("value");
    expect(c.value).toBe("value");
    // At least two of the three should report deduped.
    const dedupedCount = [a, b, c].filter((r) => r.dedupedFromInflight).length;
    expect(dedupedCount).toBeGreaterThanOrEqual(2);
  });

  it("lets different keys run independently", async () => {
    const dedup = createInflightDedup<string>();
    let invocations = 0;
    const fn = async (v: string) => {
      invocations++;
      return v;
    };

    const [a, b] = await Promise.all([
      dedup.dedupe("a", () => fn("A")),
      dedup.dedupe("b", () => fn("B")),
    ]);

    expect(invocations).toBe(2);
    expect(a.value).toBe("A");
    expect(b.value).toBe("B");
  });

  it("clears in-flight entry on failure so later callers can retry", async () => {
    const dedup = createInflightDedup<string>();
    let calls = 0;

    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    };

    await expect(dedup.dedupe("k", flaky)).rejects.toThrow("boom");
    const second = await dedup.dedupe("k", flaky);
    expect(second.value).toBe("ok");
    expect(calls).toBe(2);
    expect(dedup.size()).toBe(0);
  });

});
