import { describe, expect, it } from "vite-plus/test";

import {
  buildHermesModelsFromSessionModelState,
  hermesAuthFromInitialize,
  isSupportedHermesVersion,
} from "./status.ts";

describe("isSupportedHermesVersion", () => {
  it("requires the v0.22.3 gateway", () => {
    expect(isSupportedHermesVersion("0.22.2")).toBe(false);
    expect(isSupportedHermesVersion("0.22.3")).toBe(true);
    expect(isSupportedHermesVersion("0.23.0")).toBe(true);
    expect(isSupportedHermesVersion("1.0")).toBe(true);
    expect(isSupportedHermesVersion(null)).toBeUndefined();
  });
});

describe("hermesAuthFromInitialize", () => {
  it("is signed in only when Hermes advertises its agent method", () => {
    expect(
      hermesAuthFromInitialize({
        protocolVersion: 1,
        authMethods: [{ id: "openrouter", name: "OpenRouter" }],
      } as never),
    ).toMatchObject({ status: "authenticated", type: "openrouter" });
    expect(
      hermesAuthFromInitialize({
        protocolVersion: 1,
        authMethods: [{ id: "hermes-setup", name: "Setup", type: "terminal" }],
      } as never),
    ).toEqual({ status: "unauthenticated" });
    expect(hermesAuthFromInitialize(undefined)).toEqual({ status: "unknown" });
  });
});

describe("buildHermesModelsFromSessionModelState", () => {
  it("drops the default entry and duplicates that differ only in provider case", () => {
    const models = buildHermesModelsFromSessionModelState({
      currentModelId: "openrouter:qwen/qwen3-coder",
      availableModels: [
        { modelId: "default", name: "Default" },
        { modelId: "openrouter:qwen/qwen3-coder", name: "" },
        { modelId: "OpenRouter:qwen/qwen3-coder", name: "Qwen3 Coder" },
      ],
    });
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["openrouter:qwen/qwen3-coder", "openrouter · qwen/qwen3-coder"],
    ]);
  });
});
