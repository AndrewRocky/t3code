import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope, AgentScopeThreadId, type AgentScopeShape } from "@t3tools/shared/AgentScope";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  defaultInstanceIdForDriver,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

import { HermesSettings } from "../settings.ts";
import {
  buildHermesAcpSpawnInput,
  HERMES_DEFAULT_MODEL_SLUG,
  HERMES_DRIVER_KIND,
  hermesApprovalOptions,
  hermesLaunchRuntimeMode,
  hermesModeIdForRuntimeMode,
  hermesYoloForMode,
  resolveHermesAcpBaseModelId,
} from "./acpSupport.ts";
import { hostHermesMediaTagOptions, type HermesMediaTagOptions } from "./mediaTags.ts";
import {
  type HermesDispatchedDelegation,
  HermesRuntimeRegistry,
  makeHermesRuntime,
} from "./runtime.ts";
import { decorateHermesAdapter } from "./session.ts";
import { discoverHermesSkills } from "./skills.ts";
import { extractHermesSubagentUpdate } from "./subagents.ts";
import { normalizeHermesToolCall } from "./toolCalls.ts";

export const HERMES_PROVIDER = HERMES_DRIVER_KIND;
export const HERMES_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(HERMES_DRIVER_KIND);
const DEFAULT_HERMES_SETTINGS = Schema.decodeSync(HermesSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * Static: orchestration reads the flavor's capabilities, not the negotiated
 * ones. Native fork and fork-from-turn stay off because ACP `session/fork`
 * copies only the head; Hermes' daemon can branch at a message, but not over
 * ACP.
 */
export const HermesProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // A mode change would otherwise detach the session and kill the viewer,
    // even mid-turn; the session decorator applies it at the next turn start.
    supportsRuntimeModeSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canForkThread: false,
    canForkFromTurn: false,
  },
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsActiveSteering: true,
    // Keeps T3 from auto-steering queued notices into a running Hermes turn.
    activeSteeringInterruptsTools: true,
    supportsSteeringByInterruptRestart: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

/**
 * Agents are stopped with the server through T3's systemd scope, but a
 * gateway daemon that `hermes acp` spawns would land in that scope too and
 * take every Hermes surface's turns down with it. The viewer still exits on
 * stdin EOF when T3 goes away.
 */
const UNSCOPED_AGENT: AgentScopeShape = {
  wrap: ({ command, args }) => Effect.succeed({ command, args }),
  oomKilled: () => Effect.succeed(false),
  clear: () => Effect.void,
};

export interface HermesAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly selfInvocation: SelfInvocation;
  readonly registry?: HermesRuntimeRegistry;
  readonly mediaTagOptions?: HermesMediaTagOptions;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly onDelegationDispatched?: (delegation: HermesDispatchedDelegation) => Effect.Effect<void>;
  /** Runs before each `hermes acp` spawn: the daemon reads `config.yaml` when a session starts. */
  readonly beforeSpawn?: (cwd: string) => Effect.Effect<void>;
  /** The live model catalog from each session Hermes opens. */
  readonly onModelsDiscovered?: (
    modelState: Parameters<NonNullable<AcpAdapterV2Flavor["onSessionConfigurationUpdate"]>>[2],
  ) => Effect.Effect<void>;
  /** Replaces the spawned `hermes acp` process; the decorator still wraps it. */
  readonly makeBaseRuntime?: (
    input: AcpAdapterV2RuntimeInput,
    launch: { readonly yolo: boolean },
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

const spawnHermesRuntime = Effect.fn("HermesAdapter.spawnRuntime")(
  function* (
    options: HermesAdapterV2Options,
    { runtimePolicy: _runtimePolicy, ...input }: AcpAdapterV2RuntimeInput,
    launch: { readonly yolo: boolean },
  ) {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        interruptPromptOnCancel: input.interruptPromptOnCancel ?? false,
        spawn: buildHermesAcpSpawnInput({
          settings: options.settings,
          cwd: input.cwd,
          environment: input.processEnvironment ?? options.environment,
          homeDirectory: options.homeDirectory,
          yolo: launch.yolo,
        }),
        ...(options.settings.customModels.length === 0
          ? {}
          : {
              customModels: options.settings.customModels.map((model) =>
                typeof model === "string" ? model : model.slug,
              ),
            }),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  },
  Effect.provideService(AgentScope, UNSCOPED_AGENT),
);

export function makeHermesAcpAdapterFlavor(
  options: HermesAdapterV2Options,
  registry: HermesRuntimeRegistry,
  services: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path },
): AcpAdapterV2Flavor {
  const skillNames = (cwd: string) =>
    discoverHermesSkills(options.settings, options.environment, cwd).pipe(
      Effect.map((skills) => skills.filter((skill) => skill.enabled).map((skill) => skill.name)),
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(Path.Path, services.path),
    );
  return {
    driver: HERMES_PROVIDER,
    runtimeHarness: "Hermes",
    capabilities: HermesProviderCapabilitiesV2,
    interruptPromptOnCancel: false,
    supportsCompaction: true,
    customModels: options.settings.customModels.map((model) =>
      typeof model === "string" ? model : model.slug,
    ),
    resolveModelId: (selection) =>
      selection.model === HERMES_DEFAULT_MODEL_SLUG
        ? ""
        : (resolveHermesAcpBaseModelId(selection.model) ?? ""),
    sessionModeForPolicy: (policy) => hermesModeIdForRuntimeMode(hermesLaunchRuntimeMode(policy)),
    makeRuntime: Effect.fn("HermesAdapter.makeRuntime")(function* (input) {
      const threadId = yield* AgentScopeThreadId;
      const yolo = hermesYoloForMode(
        hermesModeIdForRuntimeMode(hermesLaunchRuntimeMode(input.runtimePolicy)),
      );
      yield* options.beforeSpawn?.(input.cwd) ?? Effect.void;
      const base =
        options.makeBaseRuntime === undefined
          ? yield* spawnHermesRuntime(options, input, { yolo })
          : yield* options.makeBaseRuntime(input, { yolo });
      const handle = yield* makeHermesRuntime(base, {
        threadId,
        cwd: input.cwd,
        launchYolo: input.resumeSessionId === undefined ? yolo : undefined,
        skillNames,
        mediaTagOptions: options.mediaTagOptions ?? hostHermesMediaTagOptions,
        ...(options.onDelegationDispatched === undefined
          ? {}
          : { onDelegationDispatched: options.onDelegationDispatched }),
      });
      yield* registry.register(handle);
      yield* Effect.addFinalizer(() => registry.unregister(handle));
      return handle.runtime;
    }),
    // Hermes enforces every mode natively, so every request it sends reaches the user.
    permissionDisposition: () => "ask",
    approvalOptions: hermesApprovalOptions,
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? { message: cause.errorMessage, code: String(cause.code), class: "provider_error" }
          : { class: "provider_error" }),
      }),
    registerExtensions: ({ runtime, finishSubagent }) =>
      Effect.sync(() => registry.attachExtensions(runtime, { finishSubagent })),
    extractSubagentUpdate: extractHermesSubagentUpdate,
    normalizeToolCall: normalizeHermesToolCall,
    ...(options.onModelsDiscovered === undefined
      ? {}
      : {
          onSessionConfigurationUpdate: (_configOptions, _modeState, modelState) =>
            options.onModelsDiscovered!(modelState),
        }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeHermesAdapterV2 = Effect.fn("makeHermesAdapterV2")(function* (
  options: HermesAdapterV2Options,
) {
  const registry = options.registry ?? new HermesRuntimeRegistry();
  const services = { fileSystem: yield* FileSystem.FileSystem, path: yield* Path.Path };
  const base = yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeHermesAcpAdapterFlavor(options, registry, services),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
  return decorateHermesAdapter(base, { registry });
});

export type HermesAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeHermesAdapterV2Driver = (
  extra: Pick<
    HermesAdapterV2Options,
    "registry" | "onDelegationDispatched" | "beforeSpawn" | "onModelsDiscovered"
  > = {},
): ProviderAdapterDriver<HermesSettings, HermesAdapterV2DriverEnv> => ({
  driverKind: HERMES_DRIVER_KIND,
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => DEFAULT_HERMES_SETTINGS,
  create: Effect.fn("HermesAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<HermesSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeHermesAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        homeDirectory,
        selfInvocation,
        continuationRequests,
        ...extra,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: HERMES_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: HERMES_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Hermes ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});

export type HermesAdapterV2 = ProviderAdapter.ProviderAdapterV2["Service"];
