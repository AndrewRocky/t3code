import { HermesSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  applyHermesAcpSessionMode,
  buildHermesAcpSpawnInput,
  currentHermesModelIdFromSessionSetup,
  formatHermesModelLabel,
  HERMES_AUTH_METHOD_SETUP,
  hermesAcpCheckArgs,
  hermesAcpSpawnArgs,
  hermesModeIdForRuntimeMode,
  resolveHermesAcpBaseModelId,
  resolveHermesModeSelection,
} from "./HermesAcpSupport.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

describe("hermes spawn", () => {
  it("launches the ACP server through the `acp` subcommand", () => {
    assert.deepStrictEqual([...hermesAcpSpawnArgs()], ["acp"]);
    assert.deepStrictEqual([...hermesAcpCheckArgs()], ["acp", "--check"]);
  });

  it("uses the configured binary and inherits the caller environment", () => {
    const spawn = buildHermesAcpSpawnInput(
      decodeHermesSettings({ binaryPath: "/opt/hermes/bin/hermes" }),
      "/workspace",
      { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-test" },
    );
    assert.equal(spawn.command, "/opt/hermes/bin/hermes");
    assert.deepStrictEqual([...spawn.args], ["acp"]);
    assert.equal(spawn.cwd, "/workspace");
    // Provider credentials must survive: Hermes resolves them itself from the
    // process environment before it ever answers `initialize`.
    assert.equal(spawn.env?.OPENROUTER_API_KEY, "sk-test");
  });

  it("falls back to `hermes` on PATH when no binary is configured", () => {
    const spawn = buildHermesAcpSpawnInput(decodeHermesSettings({}), "/workspace");
    assert.equal(spawn.command, "hermes");
  });

  it("exports HERMES_HOME only when the instance configures one", () => {
    const withHome = buildHermesAcpSpawnInput(
      decodeHermesSettings({ homePath: "/srv/hermes-home" }),
      "/workspace",
      {},
    );
    assert.equal(withHome.env?.HERMES_HOME, "/srv/hermes-home");

    const withoutHome = buildHermesAcpSpawnInput(decodeHermesSettings({}), "/workspace", {
      HERMES_HOME: "/inherited",
    });
    // Not overwritten: an inherited HERMES_HOME is the user's own choice.
    assert.equal(withoutHome.env?.HERMES_HOME, "/inherited");
  });

  it("sets the MCP skip flag to exactly '1' when enabled", () => {
    const skipping = buildHermesAcpSpawnInput(
      decodeHermesSettings({ skipConfiguredMcpServers: true }),
      "/workspace",
      {},
    );
    // Hermes compares against the literal string "1"; anything else is unset.
    assert.equal(skipping.env?.HERMES_ACP_SKIP_CONFIGURED_MCP, "1");

    const notSkipping = buildHermesAcpSpawnInput(decodeHermesSettings({}), "/workspace", {});
    assert.isUndefined(notSkipping.env?.HERMES_ACP_SKIP_CONFIGURED_MCP);
  });

  it("authenticates with the always-advertised terminal setup method", () => {
    // `hermes-setup` is the only auth method Hermes guarantees to advertise;
    // the provider-named one appears only once credentials already resolve.
    assert.equal(HERMES_AUTH_METHOD_SETUP, "hermes-setup");
  });
});

describe("hermes model ids", () => {
  it("lowercases the provider half and preserves the model half", () => {
    assert.equal(resolveHermesAcpBaseModelId("OpenRouter:z-ai/GLM-5.2"), "openrouter:z-ai/GLM-5.2");
  });

  it("passes a bare model name through without inventing a provider", () => {
    // `parse_model_input` falls back to `detect_provider_for_model`; guessing a
    // prefix here could route the request to the wrong endpoint.
    assert.equal(resolveHermesAcpBaseModelId("gpt-4o"), "gpt-4o");
  });

  it("falls back to the documented default for empty input", () => {
    assert.equal(resolveHermesAcpBaseModelId(undefined), "openrouter:z-ai/glm-5.2");
    assert.equal(resolveHermesAcpBaseModelId("   "), "openrouter:z-ai/glm-5.2");
  });

  it("leaves a trailing or leading colon alone rather than producing an empty half", () => {
    assert.equal(resolveHermesAcpBaseModelId("openrouter:"), "openrouter:");
    assert.equal(resolveHermesAcpBaseModelId(":glm"), ":glm");
  });

  it("formats a readable label from a provider-qualified id", () => {
    assert.equal(formatHermesModelLabel("openrouter:z-ai/glm-5.2"), "openrouter · z-ai/glm-5.2");
    assert.equal(formatHermesModelLabel("gpt-4o"), "gpt-4o");
  });

  it("reads the model bound to a session from its setup response", () => {
    assert.equal(
      currentHermesModelIdFromSessionSetup({
        models: {
          currentModelId: " nous:hermes-4-405b ",
          availableModels: [{ modelId: "nous:hermes-4-405b", name: "Hermes 4" }],
        },
      }),
      "nous:hermes-4-405b",
    );
    assert.isUndefined(currentHermesModelIdFromSessionSetup({}));
  });
});

describe("applyHermesAcpModelSelection", () => {
  const mapError = (cause: EffectAcpErrors.AcpError) => cause;

  it.effect("does not re-send a model that is already bound", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);
      const result = yield* applyHermesAcpModelSelection({
        runtime: {
          setSessionModel: (modelId) =>
            Ref.update(calls, (current) => [...current, modelId]).pipe(Effect.as({})),
        },
        currentModelId: "openrouter:z-ai/glm-5.2",
        requestedModelId: "openrouter:z-ai/glm-5.2",
        mapError,
      });
      assert.equal(result, "openrouter:z-ai/glm-5.2");
      // Hermes rebuilds its agent on a provider change, dropping the session's
      // base_url/api_mode overrides — so a redundant set is not free.
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }),
  );

  it.effect("sends and returns a changed model", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);
      const result = yield* applyHermesAcpModelSelection({
        runtime: {
          setSessionModel: (modelId) =>
            Ref.update(calls, (current) => [...current, modelId]).pipe(Effect.as({})),
        },
        currentModelId: "openrouter:z-ai/glm-5.2",
        requestedModelId: "nous:hermes-4-405b",
        mapError,
      });
      assert.equal(result, "nous:hermes-4-405b");
      assert.deepStrictEqual(yield* Ref.get(calls), ["nous:hermes-4-405b"]);
    }),
  );

  it.effect("keeps the current model when nothing was requested", () =>
    Effect.gen(function* () {
      const result = yield* applyHermesAcpModelSelection({
        runtime: { setSessionModel: () => Effect.die("must not be called") },
        currentModelId: "openrouter:z-ai/glm-5.2",
        requestedModelId: undefined,
        mapError,
      });
      assert.equal(result, "openrouter:z-ai/glm-5.2");
    }),
  );
});

describe("hermes session modes", () => {
  it("maps runtime modes onto Hermes edit-approval modes", () => {
    assert.equal(hermesModeIdForRuntimeMode("approval-required"), "default");
    assert.equal(hermesModeIdForRuntimeMode("auto-accept-edits"), "accept_edits");
    // `auto` means "don't interrupt me inside the workspace", which is
    // `accept_edits` (cwd + tmp), not `dont_ask` (anywhere on disk).
    assert.equal(hermesModeIdForRuntimeMode("auto"), "accept_edits");
    assert.equal(hermesModeIdForRuntimeMode("full-access"), "dont_ask");
    assert.equal(hermesModeIdForRuntimeMode(undefined), "default");
  });

  const hermesModeState = {
    currentModeId: "default",
    availableModes: [{ id: "default" }, { id: "accept_edits" }, { id: "dont_ask" }],
  };

  it("requests nothing when the target mode is already active", () => {
    assert.isUndefined(
      resolveHermesModeSelection({
        modeState: hermesModeState,
        runtimeMode: "approval-required",
      }),
    );
  });

  it("requests a mode the agent advertises", () => {
    assert.equal(
      resolveHermesModeSelection({ modeState: hermesModeState, runtimeMode: "full-access" }),
      "dont_ask",
    );
  });

  it("requests nothing when the agent does not advertise the target mode", () => {
    // Hermes coerces an unknown mode id to `default`, which would silently
    // *tighten* permissions instead of failing — so we never send one.
    assert.isUndefined(
      resolveHermesModeSelection({
        modeState: { currentModeId: "default", availableModes: [{ id: "default" }] },
        runtimeMode: "full-access",
      }),
    );
  });

  it("requests nothing when the agent reported no modes at all", () => {
    assert.isUndefined(
      resolveHermesModeSelection({ modeState: undefined, runtimeMode: "full-access" }),
    );
  });

  it.effect("drives session/set_mode and returns the mode it asked for", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);
      const result = yield* applyHermesAcpSessionMode({
        runtime: {
          getModeState: Effect.succeed({
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "dont_ask", name: "Don't Ask" },
            ],
          }),
          setSessionMode: (modeId) =>
            Ref.update(calls, (current) => [...current, modeId]).pipe(Effect.as({})),
        },
        runtimeMode: "full-access",
        mapError: (cause: EffectAcpErrors.AcpError) => cause,
      });
      assert.equal(result, "dont_ask");
      assert.deepStrictEqual(yield* Ref.get(calls), ["dont_ask"]);
    }),
  );

  it.effect("returns the live mode without a request when it already matches", () =>
    Effect.gen(function* () {
      const result = yield* applyHermesAcpSessionMode({
        runtime: {
          getModeState: Effect.succeed({
            currentModeId: "accept_edits",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "accept_edits", name: "AE" },
            ],
          }),
          setSessionMode: () => Effect.die("must not be called"),
        },
        runtimeMode: "auto-accept-edits",
        mapError: (cause: EffectAcpErrors.AcpError) => cause,
      });
      assert.equal(result, "accept_edits");
    }),
  );
});
