/**
 * HermesProvider — availability probe and model catalog for Hermes Agent.
 *
 * The probe ladder has one rung the other ACP providers do not need. Hermes
 * ships its ACP adapter as an *optional* extra: a stock install answers
 * `hermes --version` perfectly well and then fails to speak ACP at all,
 * because `agent-client-protocol` was never installed. `hermes acp --check`
 * imports the adapter and exits, so it separates "Hermes is missing" from
 * "Hermes is here but cannot do ACP" — two problems with completely different
 * fixes — without paying for a full session handshake.
 *
 * The model catalog comes from the session Hermes hands back, not from a
 * static list. Hermes has no models of its own: it federates OpenRouter, Nous
 * Portal, OpenAI, Anthropic, local endpoints, and anything the user declared
 * under `providers:` in `config.yaml`. Only the running agent knows which of
 * those are configured, so discovery opens a throwaway ACP session and reads
 * `session/new`'s `models` block, exactly as the Hermes TUI's `/model` picker
 * does. When that fails the snapshot falls back to the user's `customModels`,
 * so the provider stays usable rather than looking empty.
 *
 * @module provider/Layers/HermesProvider
 */
import {
  type HermesSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { discoverHermesSkills } from "../Drivers/HermesSkills.ts";
import {
  formatHermesModelLabel,
  hermesAcpCheckArgs,
  makeHermesAcpRuntime,
  resolveHermesAcpBaseModelId,
} from "../acp/HermesAcpSupport.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  // Hermes implements the unstable `session/set_model` route, so a model
  // change applies to the live session and never needs a new thread.
  showInteractionModeToggle: false,
} as const;

/**
 * Hermes advertises no per-model options over ACP — its `ModelInfo` entries
 * carry only `modelId`, `name`, and a provider description — so every model
 * gets the empty capability set. Reasoning effort, when a model supports it,
 * is configured on the Hermes side in `config.yaml`.
 */
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_DEPENDENCY_PROBE_TIMEOUT_MS = 15_000;
const HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Fallback catalog. Deliberately empty rather than a made-up default: Hermes
 * has no first-party model, and inventing one would show a picker entry that
 * fails the moment it is selected. An install with no discoverable models is
 * an unconfigured install, and the probe message says so.
 */
const HERMES_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [];

const ACP_EXTRA_INSTALL_HINT =
  "Hermes is installed but its ACP adapter is missing. Install it with `pip install -e '.[acp]'` in the Hermes checkout, or re-run the Hermes installer.";

function hermesModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = HERMES_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = hermesModelsFromSettings(hermesSettings.customModels);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes CLI availability...",
      },
    });
  });
}

/**
 * Map the live ACP model catalog onto provider models.
 *
 * Ids are Hermes' `<provider>:<model>` encoding and are used verbatim as the
 * slug, so a selection stored in settings is exactly what `session/set_model`
 * receives later. The display name Hermes sends is already
 * `"<Provider> · <model>"`; when it is missing, the label is derived from the
 * id so the picker never falls back to a raw colon-joined string.
 */
export function buildHermesDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveHermesAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || formatHermesModelLabel(slug),
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const discoverHermesModelsViaAcp = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildHermesDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

const runHermesCommand = (
  hermesSettings: Pick<HermesSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(command, [...args], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = hermesModelsFromSettings(hermesSettings.customModels);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runHermesCommand(hermesSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Hermes CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Hermes CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute Hermes CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but timed out while running `hermes --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Hermes CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but failed to run.",
      },
    });
  }

  // The `[acp]` extra check. A stock `pip install hermes-agent` has no
  // `agent-client-protocol`, and every later rung would then fail with a
  // spawn-level error that says nothing about the actual fix.
  const acpCheckResult = yield* runHermesCommand(
    hermesSettings,
    hermesAcpCheckArgs(),
    environment,
    cwd,
  ).pipe(Effect.timeoutOption(ACP_DEPENDENCY_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(acpCheckResult) || Option.isNone(acpCheckResult.success)) {
    yield* Effect.logWarning("Hermes ACP dependency check did not complete.");
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Hermes CLI is installed but \`hermes acp --check\` did not complete within ${ACP_DEPENDENCY_PROBE_TIMEOUT_MS}ms.`,
      },
    });
  }

  const acpCheckOutput = acpCheckResult.success.value;
  if (acpCheckOutput.code !== 0) {
    yield* Effect.logWarning("Hermes ACP adapter is unavailable.", {
      exitCode: acpCheckOutput.code,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: ACP_EXTRA_INSTALL_HINT,
      },
    });
  }

  const skills = yield* discoverHermesSkills(hermesSettings, environment, cwd);

  const discoveryExit = yield* discoverHermesModelsViaAcp(hermesSettings, environment, cwd).pipe(
    Effect.timeoutOption(HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Hermes ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Hermes ACP model discovery timed out after ${HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Hermes CLI is installed but ACP startup timed out after ${HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discoveredModels = discoveryExit.value.value;
  const models =
    discoveredModels.length > 0
      ? hermesModelsFromSettings(hermesSettings.customModels, discoveredModels)
      : fallbackModels;

  // Reaching here means the handshake succeeded, so the transport is healthy.
  // An empty catalog then means Hermes has no provider credentials configured
  // — `hermes model` is the fix, and `hermes acp --setup` runs the same flow.
  if (models.length === 0) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models,
      skills,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "Hermes is installed but has no configured models. Run `hermes model` to pick a provider and sign in.",
      },
    });
  }

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
    checkedAt,
    models,
    skills,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichHermesSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
