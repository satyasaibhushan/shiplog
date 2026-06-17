import { describe, expect, it } from "bun:test";
import {
  getProviderModels,
  mergeProviderModels,
  type LLMModelOption,
} from "../../src/shared/llm-models.ts";

describe("mergeProviderModels", () => {
  it("keeps configured models first when they are runtime-available and appends extras", () => {
    const runtime: LLMModelOption[] = [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        description: "Runtime strongest",
      },
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        description: "Runtime extra",
      },
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4-Mini",
        description: "Runtime mini",
      },
    ];

    const merged = mergeProviderModels("codex", runtime);

    expect(merged.map((entry) => entry.id)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.4",
    ]);
    expect(merged[0]?.label).toBe("GPT-5.4 Mini");
    expect(merged[1]?.label).toBe("GPT-5.5");
    expect(merged[2]?.label).toBe("GPT-5.4");
  });

  it("falls back to configured models when runtime discovery is unavailable", () => {
    expect(mergeProviderModels("claude", null)).toEqual(
      getProviderModels("claude"),
    );
    expect(mergeProviderModels("cursor", [])).toEqual(
      getProviderModels("cursor"),
    );
  });
});