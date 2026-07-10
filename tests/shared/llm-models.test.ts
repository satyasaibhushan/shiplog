import { describe, expect, it } from "bun:test";
import {
  getProviderModels,
  mergeProviderModels,
  normalizeProviderId,
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

    const merged = mergeProviderModels("codex-cli", runtime);

    expect(merged.map((entry) => entry.id)).toEqual(["gpt-5.4-mini", "gpt-5.5", "gpt-5.4"]);
    expect(merged[0]?.label).toBe("GPT-5.4 Mini");
    expect(merged[1]?.label).toBe("GPT-5.5");
    expect(merged[2]?.label).toBe("GPT-5.4");
  });

  it("falls back to configured models when runtime discovery is unavailable", () => {
    expect(mergeProviderModels("claude-cli", null)).toEqual(getProviderModels("claude-cli"));
    expect(mergeProviderModels("cursor-cli", [])).toEqual(getProviderModels("cursor-cli"));
  });
});

describe("normalizeProviderId", () => {
  it("keeps ModelBridge ids and migrates legacy CLI ids", () => {
    expect(normalizeProviderId("copilot-cli")).toBe("copilot-cli");
    expect(normalizeProviderId("claude")).toBe("claude-cli");
    expect(normalizeProviderId("codex")).toBe("codex-cli");
    expect(normalizeProviderId("unknown")).toBeNull();
  });
});
