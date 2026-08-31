import { HermesSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildHermesDiscoveredModelsFromSessionModelState,
  buildInitialHermesProviderSnapshot,
} from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

describe("buildInitialHermesProviderSnapshot", () => {
  it.effect("reports the disabled state without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      // Hermes ships ACP as an optional extra, so it is opt-in by default.
      assert.isFalse(snapshot.enabled);
      assert.equal(snapshot.status, "disabled");
      assert.equal(snapshot.message, "Hermes is disabled in T3 Code settings.");
    }),
  );

  it.effect("paints a checking state when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: true }),
      );
      assert.isTrue(snapshot.enabled);
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.message, "Checking Hermes CLI availability...");
      assert.equal(snapshot.displayName, "Hermes");
      assert.equal(snapshot.badgeLabel, "Early Access");
    }),
  );

  it.effect("surfaces custom models before any discovery has run", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: true, customModels: ["openai:gpt-4o"] }),
      );
      assert.deepStrictEqual(
        snapshot.models.map((model) => model.slug),
        ["openai:gpt-4o"],
      );
    }),
  );

  it.effect("ships no built-in models", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: true }),
      );
      // Hermes federates other providers and has no model of its own; a
      // fabricated default would fail the moment it was selected.
      assert.deepStrictEqual([...snapshot.models], []);
    }),
  );
});

describe("buildHermesDiscoveredModelsFromSessionModelState", () => {
  it("keeps the provider-qualified id as the slug", () => {
    // The slug is what `session/set_model` receives later, so it must be the
    // id Hermes reported, not a prettified form of it.
    assert.deepStrictEqual(
      [
        ...buildHermesDiscoveredModelsFromSessionModelState({
          currentModelId: "openrouter:z-ai/glm-5.2",
          availableModels: [
            { modelId: "openrouter:z-ai/glm-5.2", name: "OpenRouter · z-ai/glm-5.2" },
            { modelId: "nous:hermes-4-405b", name: "Nous Portal · hermes-4-405b" },
          ],
        }),
      ].map((model) => ({ slug: model.slug, name: model.name })),
      [
        { slug: "openrouter:z-ai/glm-5.2", name: "OpenRouter · z-ai/glm-5.2" },
        { slug: "nous:hermes-4-405b", name: "Nous Portal · hermes-4-405b" },
      ],
    );
  });

  it("derives a label when the agent sends a blank name", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "openrouter:z-ai/glm-5.2",
      availableModels: [{ modelId: "openrouter:z-ai/glm-5.2", name: "   " }],
    });
    assert.equal(models[0]?.name, "openrouter · z-ai/glm-5.2");
  });

  it("de-duplicates ids that normalize to the same slug", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "openrouter:glm",
      availableModels: [
        { modelId: "OpenRouter:glm", name: "A" },
        { modelId: "openrouter:glm", name: "B" },
      ],
    });
    assert.deepStrictEqual(
      models.map((model) => model.slug),
      ["openrouter:glm"],
    );
  });

  it("returns an empty catalog for a missing or empty model state", () => {
    assert.deepStrictEqual([...buildHermesDiscoveredModelsFromSessionModelState(undefined)], []);
    assert.deepStrictEqual(
      [
        ...buildHermesDiscoveredModelsFromSessionModelState({
          currentModelId: "",
          availableModels: [],
        }),
      ],
      [],
    );
  });
});
