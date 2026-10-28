import type {
  CustomModelSetting,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";

import type { HermesSettings } from "../settings.ts";
import {
  buildHermesAcpSpawnInput,
  formatHermesModelLabel,
  HERMES_DRIVER_KIND,
  HERMES_SUPPORTED_RUNTIME_MODES,
  hermesAcpCheckArgs,
  hermesAcpVersionArgs,
  resolveHermesAcpBaseModelId,
} from "./acpSupport.ts";
import { resolveHermesHomePath } from "./home.ts";
import { discoverHermesSkills } from "./skills.ts";
import {
  annotateHermesSkillsWithEnableState,
  discoverHermesEnabledSkillNames,
} from "./skillState.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  // The shared ACP rollback resets Hermes to an empty session.
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  supportedRuntimeModes: HERMES_SUPPORTED_RUNTIME_MODES,
} as const;

/** Hermes' `ModelInfo` carries no per-model options; effort is set in `config.yaml`. */
export const HERMES_EMPTY_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const EMPTY_CAPABILITIES = HERMES_EMPTY_MODEL_CAPABILITIES;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_CHECK_TIMEOUT_MS = 15_000;
const ACP_INITIALIZE_TIMEOUT_MS = 20_000;

/** v0.22.3 is the first stable release of the gateway viewer; older builds run the in-process server. */
const MINIMUM_GATEWAY_VERSION = [0, 22, 3] as const;

const ACP_EXTRA_INSTALL_HINT =
  "Hermes is installed but its ACP adapter is missing. Re-run the Hermes installer, or install the `acp` extra in the Hermes checkout.";

/**
 * Hermes intercepts these itself (`acp_adapter/gateway_session_meta.py`).
 * Withheld: `model` (T3's own `/model` opens the picker), `steer` and `queue`
 * (the composer does both), and `undo`, `retry` and `reset`, which rewrite
 * Hermes' history behind T3's thread. `discard` is not advertised, but it is
 * the way out Hermes names when a lost turn blocks the session.
 */
const HERMES_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  COMPACT_SLASH_COMMAND,
  { name: "help", description: "List available commands" },
  { name: "tools", description: "List available tools" },
  { name: "context", description: "Show conversation context usage" },
  { name: "usage", description: "Show token usage and rate limits" },
  { name: "status", description: "Show session, model, token, and context info" },
  { name: "version", description: "Show Hermes version" },
  { name: "title", description: "Show or set the session title", input: { hint: "new title" } },
  {
    name: "discard",
    description: "Discard a lost turn that blocks the session",
    input: { hint: "lost turn id" },
  },
];

/** An empty fallback, not an invented default: only a configured Hermes knows its models. */
export function hermesModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discovered, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildHermesModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) return [];
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = resolveHermesAcpBaseModelId(model.modelId);
    if (slug === undefined || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || formatHermesModelLabel(slug),
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

export function isSupportedHermesVersion(version: string | null): boolean | undefined {
  if (version === null) return undefined;
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < MINIMUM_GATEWAY_VERSION.length; index += 1) {
    const actual = parts[index] ?? 0;
    const minimum = MINIMUM_GATEWAY_VERSION[index]!;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

/**
 * An agent auth method is advertised only when Hermes resolves provider
 * credentials (`acp_adapter/auth.py`); otherwise only the terminal setup.
 */
export function hermesAuthFromInitialize(
  initialized: EffectAcpSchema.InitializeResponse | undefined,
): ServerProviderAuth {
  const methods = initialized?.authMethods ?? [];
  const agentMethod = methods.find(
    (method) => !("type" in method) || method.type === undefined || method.type === "agent",
  );
  if (agentMethod !== undefined) {
    return { status: "authenticated", type: agentMethod.id, label: `Hermes (${agentMethod.id})` };
  }
  return initialized === undefined ? { status: "unknown" } : { status: "unauthenticated" };
}

/** The last line Hermes printed, so a failed probe says why instead of only that it failed. */
function lastOutputLine(output: { readonly stdout: string; readonly stderr: string }): string {
  const line = `${output.stderr}\n${output.stdout}`
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .at(-1);
  if (line === undefined) return "";
  return `: ${line.length <= 200 ? line : `${line.slice(0, 199)}…`}`;
}

const runHermesCommand = Effect.fn("HermesProviderStatus.runHermesCommand")(function* (
  settings: Pick<HermesSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const command = settings.binaryPath || "hermes";
  const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      ...(cwd ? { cwd } : {}),
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/** `initialize` is answered by the viewer itself; it neither opens a session nor starts the daemon. */
const initializeHermes = Effect.fn("HermesProviderStatus.initialize")(function* (
  settings: HermesSettings,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  cwd: string,
) {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      spawn: buildHermesAcpSpawnInput({
        settings,
        cwd,
        environment,
        homeDirectory,
        yolo: false,
      }),
    }),
  );
  const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(context),
  );
  return yield* runtime.initialize();
}, Effect.scoped);

/**
 * Skills from the filesystem scan, annotated with Hermes' own enable state.
 * Both halves run in `cwd`, because the listing derives its project root and
 * trust decision from its own working directory.
 */
export const discoverHermesSkillsForCwd = Effect.fn("discoverHermesSkillsForCwd")(function* (
  settings: HermesSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const discovered = yield* discoverHermesSkills(settings, environment, cwd);
  const listing = yield* discoverHermesEnabledSkillNames(settings, environment, cwd);
  const annotated = annotateHermesSkillsWithEnableState(discovered, listing);
  if (annotated === undefined) return discovered;
  const projectSkills = annotated.filter((skill) => skill.scope === "project");
  if (projectSkills.length > 0 && projectSkills.every((skill) => !skill.enabled)) {
    yield* Effect.logInfo(
      "Hermes loads none of this workspace's project skills; the project is probably not trusted for this Hermes profile (`hermes skills trust`).",
      {
        cwd,
        hermesHome: yield* resolveHermesHomePath(settings, environment, cwd),
        projectSkills: projectSkills.length,
      },
    );
  }
  return annotated;
});

export const buildInitialHermesProviderSnapshot = Effect.fn(
  "HermesProviderStatus.buildInitialHermesProviderSnapshot",
)(function* (
  settings: HermesSettings,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = hermesModelsFromSettings(settings.customModels, discoveredModels);
  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    ...(settings.enabled ? { slashCommands: HERMES_SLASH_COMMANDS } : {}),
    probe: {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Hermes CLI availability..."
        : "Hermes is disabled in T3 Code settings.",
    },
  });
});

/**
 * Session-free by design: every Hermes `session/new` lands in the shared
 * gateway daemon, so the background probe uses `--version`, `--check` and
 * `initialize` only. The model catalog comes from real sessions and from the
 * explicit refresh.
 */
export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (input: {
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly cwd: string;
  readonly discoveredModels: ReadonlyArray<ServerProviderModel>;
}): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const { settings, environment } = input;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = hermesModelsFromSettings(settings.customModels, input.discoveredModels);
  const snapshot = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    extra: {
      readonly skills?: ReadonlyArray<ServerProviderSkill>;
      readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
    } = {},
  ) =>
    buildServerProvider({
      driver: HERMES_DRIVER_KIND,
      presentation: HERMES_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      ...extra,
      probe,
    });

  if (!settings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Hermes is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runHermesCommand(settings, hermesAcpVersionArgs(), environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return snapshot({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Hermes CLI (`hermes`) is not installed or not on PATH."
        : "Failed to run `hermes acp --version`.",
    });
  }
  if (Option.isNone(versionResult.success) || versionResult.success.value.code !== 0) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: Option.isNone(versionResult.success)
        ? "Hermes is installed but timed out on `hermes acp --version`."
        : `Hermes is installed but \`hermes acp --version\` failed${lastOutputLine(versionResult.success.value)}`,
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (isSupportedHermesVersion(version) === false) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `Hermes ${version ?? ""} runs the old in-process ACP server. Update Hermes to 0.22.5 or later.`,
    });
  }

  const checkResult = yield* runHermesCommand(settings, hermesAcpCheckArgs(), environment).pipe(
    Effect.timeoutOption(ACP_CHECK_TIMEOUT_MS),
    Effect.result,
  );
  const checkPassed =
    Result.isSuccess(checkResult) &&
    Option.isSome(checkResult.success) &&
    checkResult.success.value.code === 0;
  if (!checkPassed) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        Result.isSuccess(checkResult) && Option.isSome(checkResult.success)
          ? `${ACP_EXTRA_INSTALL_HINT} (\`hermes acp --check\`${lastOutputLine(checkResult.success.value)})`
          : ACP_EXTRA_INSTALL_HINT,
    });
  }

  const initializeExit = yield* initializeHermes(
    settings,
    environment,
    input.homeDirectory,
    input.cwd,
  ).pipe(Effect.timeoutOption(ACP_INITIALIZE_TIMEOUT_MS), Effect.exit);
  const initialized = Exit.isSuccess(initializeExit)
    ? Option.getOrUndefined(initializeExit.value)
    : undefined;
  if (initialized === undefined) {
    yield* Effect.logWarning("Hermes ACP initialize probe failed or timed out.", {
      errorTag: Exit.isFailure(initializeExit) ? causeErrorTag(initializeExit.cause) : "Timeout",
    });
  }
  const auth = hermesAuthFromInitialize(initialized);
  const skills = yield* discoverHermesSkillsForCwd(settings, environment, input.cwd);

  if (auth.status === "unauthenticated") {
    return snapshot(
      {
        installed: true,
        version,
        status: "warning",
        auth,
        message:
          "Hermes has no model provider configured. Run `hermes model` (or `hermes acp --setup`) to configure one.",
      },
      { skills, slashCommands: HERMES_SLASH_COMMANDS },
    );
  }
  return snapshot(
    {
      installed: true,
      version,
      status: initialized === undefined ? "warning" : "ready",
      auth,
      ...(initialized === undefined
        ? { message: "Hermes is installed but its ACP handshake failed." }
        : models.length === 0
          ? {
              message:
                "Hermes reports its models when a session starts. Refresh models in provider settings to load them now.",
            }
          : {}),
    },
    { skills, slashCommands: HERMES_SLASH_COMMANDS },
  );
});

export const enrichHermesSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
