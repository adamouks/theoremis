import { describe, expect, it } from "vitest";
import { effortLabel, effortNote, resolveEffort } from "./effort";
import type { ModelInfo } from "./types";

const model = (efforts: string[], defaultEffort: string | null = null): ModelInfo => ({
  provider: "chatgpt",
  id: "gpt-6",
  name: null,
  detail: null,
  vision: true,
  tools: true,
  efforts: efforts.map((id) => ({ id, description: null })),
  defaultEffort,
});

describe("efforts", () => {
  it("keeps a choice the model still offers", () => {
    expect(resolveEffort(model(["low", "medium", "high"], "medium"), "high")).toBe("high");
  });

  it("falls back to the default, then the middle", () => {
    expect(resolveEffort(model(["low", "medium", "high"], "low"), "xhigh")).toBe("low");
    expect(resolveEffort(model(["low", "medium", "high", "xhigh"]), undefined)).toBe("medium");
    expect(resolveEffort(model(["none", "think"]), undefined)).toBe("none");
  });

  it("asks for nothing when there is no choice", () => {
    expect(resolveEffort(model([]), "high")).toBeUndefined();
    expect(resolveEffort(undefined, "high")).toBeUndefined();
  });

  it("names efforts for people", () => {
    expect(effortLabel("none")).toBe("Instant");
    expect(effortLabel("xhigh")).toBe("Max");
    expect(effortLabel("turbo")).toBe("Turbo");
    expect(effortNote({ id: "high", description: "Provider says" })).toBe("Provider says");
    expect(effortNote({ id: "high", description: null })).toContain("hard problems");
  });
});
