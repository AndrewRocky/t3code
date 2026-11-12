import { describe, expect, it } from "vite-plus/test";

import {
  buildHermesModelsFromSessionModelState,
  hermesAuthFromInitialize,
  isSupportedHermesVersion,
  resolveProvisionalCustomAlias,
  withoutProvisionalCustomAliases,
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

  // Recorded from Hermes 0.23.0 on a named custom endpoint, before the session's first turn.
  const namedEndpoint = {
    currentModelId: "custom:rnd-glm",
    availableModels: [
      { modelId: "custom:rnd-glm", name: "custom · rnd-glm" },
      { modelId: "custom:local-gateway:rnd-glm", name: "rnd-glm" },
    ],
  };

  it("hides the provisional id a named custom endpoint reports before its first turn", () => {
    expect(
      buildHermesModelsFromSessionModelState(namedEndpoint).map((model) => model.slug),
    ).toEqual(["custom:local-gateway:rnd-glm"]);
    // A plain custom endpoint has no other id, so it keeps its own.
    expect(
      buildHermesModelsFromSessionModelState({
        currentModelId: "custom:rnd-glm",
        availableModels: [{ modelId: "custom:rnd-glm", name: "custom · rnd-glm" }],
      }).map((model) => model.slug),
    ).toEqual(["custom:rnd-glm"]);
  });

  it("offers Hermes' reasoning effort on every model, and no other session setting", () => {
    const [model] = buildHermesModelsFromSessionModelState(namedEndpoint, [
      {
        id: "edit_approval_policy",
        name: "Edits",
        category: "mode",
        type: "select",
        currentValue: "ask",
        options: [{ name: "Default", value: "ask" }],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
        ],
      },
    ]);
    expect(model?.capabilities?.optionDescriptors).toEqual([
      expect.objectContaining({
        id: "reasoning_effort",
        role: "reasoning",
        currentValue: "medium",
        options: [
          expect.objectContaining({ id: "low" }),
          expect.objectContaining({ id: "medium" }),
          expect.objectContaining({ id: "high" }),
        ],
      }),
    ]);
  });
});

describe("resolveProvisionalCustomAlias", () => {
  const catalog = ["custom:local-gateway:rnd-glm", "custom:local-gateway:fast", "openai:gpt-5"];

  it("moves a thread on the provisional id to its endpoint's own id", () => {
    expect(resolveProvisionalCustomAlias("custom:rnd-glm", catalog)).toBe(
      "custom:local-gateway:rnd-glm",
    );
    expect(resolveProvisionalCustomAlias("custom:local-gateway:fast", catalog)).toBe(
      "custom:local-gateway:fast",
    );
    expect(resolveProvisionalCustomAlias("openai:gpt-5", catalog)).toBe("openai:gpt-5");
  });

  it("keeps an id the catalog offers, or one no single endpoint claims", () => {
    // A plain custom endpoint's model is its own id.
    expect(resolveProvisionalCustomAlias("custom:rnd-glm", ["custom:rnd-glm"])).toBe(
      "custom:rnd-glm",
    );
    expect(
      resolveProvisionalCustomAlias("custom:rnd-glm", [
        "custom:local-gateway:rnd-glm",
        "custom:backup:rnd-glm",
      ]),
    ).toBe("custom:rnd-glm");
    expect(resolveProvisionalCustomAlias("custom:rnd-glm", [])).toBe("custom:rnd-glm");
  });
});

describe("withoutProvisionalCustomAliases", () => {
  it("drops a saved provisional id whose endpoint id is saved too", () => {
    const saved = [
      { slug: "custom:rnd-glm" },
      { slug: "custom:local-gateway:rnd-glm" },
      { slug: "custom:fast" },
      { slug: "openai:gpt-5" },
    ];
    expect(withoutProvisionalCustomAliases(saved).map(({ slug }) => slug)).toEqual([
      "custom:local-gateway:rnd-glm",
      "custom:fast",
      "openai:gpt-5",
    ]);
  });
});
