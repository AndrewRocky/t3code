import type { ServerProviderModel } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

import { HermesSettings } from "../settings.ts";
import { buildHermesAcpSpawnInput, HERMES_DRIVER_KIND } from "./acpSupport.ts";
import { type HermesAdapterV2DriverEnv, makeHermesAdapterV2Driver } from "./adapter.ts";
import { syncHermesCommandRules } from "./commandRules.ts";
import { makeHermesDelegationWatcher, makeHermesLedgerReader } from "./delegations.ts";
import { buildHermesEnvironment, resolveHermesHomePath } from "./home.ts";
import { HermesRuntimeRegistry } from "./runtime.ts";
import { makeHermesAdmissionReader } from "./workState.ts";
import {
  buildHermesModelsFromSessionModelState,
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  discoverHermesSkillsForCwd,
  enrichHermesSnapshot,
  HERMES_EMPTY_MODEL_CAPABILITIES,
  hermesModelsFromSettings,
} from "./status.ts";
import { makeHermesTextGeneration } from "./textGeneration.ts";
import { syncHermesWorktreeTrust } from "./worktreeTrust.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const CachedModels = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
);
const decodeCachedModels = Schema.decodeUnknownEffect(CachedModels);
const encodeCachedModels = Schema.encodeSync(CachedModels);

const MODEL_REFRESH_TIMEOUT = "90 seconds";

export type HermesDriverEnv =
  | HermesAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv, Path.Path> = {
  driverKind: HERMES_DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => decodeHermesSettings({}),
  create: Effect.fn("HermesDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const settings = { ...config, enabled } satisfies HermesSettings;
    // Every command the driver runs (probe, skills listing, text generation) must reach the
    // configured Hermes home: a binary installed under it may not run against another one.
    const processEnv = buildHermesEnvironment({
      config: settings,
      environment: yield* mergeProviderInstanceEnvironment(environment),
      homeDirectory,
    });
    const provideFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: HERMES_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: HERMES_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });

    // The catalog comes from sessions Hermes really opens, kept across restarts.
    const catalogPath = path.join(
      host.paths.stateDir,
      "provider-hermes",
      `${instanceId}-models.json`,
    );
    const initialCatalog = yield* fileSystem.readFileString(catalogPath).pipe(
      Effect.flatMap(decodeCachedModels),
      Effect.map((entries) =>
        entries.map((entry): ServerProviderModel => ({
          slug: entry.slug,
          name: entry.name,
          isCustom: false,
          capabilities: HERMES_EMPTY_MODEL_CAPABILITIES,
        })),
      ),
      Effect.orElseSucceed((): ReadonlyArray<ServerProviderModel> => []),
    );
    const catalog = yield* Ref.make(initialCatalog);
    const catalogChanges = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProviderModel>>(),
      PubSub.shutdown,
    );
    const publishCatalog = Effect.fn("HermesDriver.publishCatalog")(function* (
      models: ReadonlyArray<ServerProviderModel>,
    ) {
      if (models.length === 0) return;
      const previous = yield* Ref.getAndSet(catalog, models);
      if (
        previous.length === models.length &&
        previous.every((model, index) => model.slug === models[index]?.slug)
      ) {
        return;
      }
      yield* PubSub.publish(catalogChanges, models);
      yield* writeFileStringAtomically({
        filePath: catalogPath,
        contents: encodeCachedModels(models.map(({ slug, name }) => ({ slug, name }))),
      }).pipe(
        provideFiles,
        Effect.catchCause((cause) =>
          Effect.logDebug("Could not persist the Hermes model catalog.", { cause }),
        ),
      );
    });

    const syncConfig = (cwd: string) =>
      Effect.all([
        syncHermesCommandRules(settings, processEnv, cwd),
        syncHermesWorktreeTrust(settings, processEnv, cwd),
      ]).pipe(Effect.asVoid, provideFiles);

    const registry = new HermesRuntimeRegistry();
    const hermesHome = yield* resolveHermesHomePath(settings, processEnv).pipe(provideFiles);
    const stateDb = path.join(hermesHome, "state.db");
    const delegations = yield* makeHermesDelegationWatcher({
      registry,
      readLedger: makeHermesLedgerReader(stateDb),
    });

    const orchestrationAdapter = yield* makeHermesAdapterV2Driver({
      registry,
      onDelegationDispatched: delegations.track,
      pendingBackgroundWork: delegations.pendingBackgroundWork,
      readAdmissions: makeHermesAdmissionReader(stateDb),
      beforeSpawn: syncConfig,
      onModelsDiscovered: (modelState) =>
        publishCatalog(buildHermesModelsFromSessionModelState(modelState)),
    })
      .create({ instanceId, displayName, accentColor, environment, enabled, config })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: HERMES_DRIVER_KIND,
              instanceId,
              detail: "Failed to build Hermes orchestration adapter.",
              cause,
            }),
        ),
      );
    const textGeneration = yield* makeHermesTextGeneration(settings, processEnv, homeDirectory);

    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: HERMES_DRIVER_KIND,
          packageName: null,
        }),
      ),
    );

    const checkProvider = Ref.get(catalog).pipe(
      Effect.flatMap((discoveredModels) =>
        checkHermesProviderStatus({
          settings,
          environment: processEnv,
          homeDirectory,
          cwd: host.paths.cwd,
          discoveredModels,
        }),
      ),
      Effect.map(stampIdentity),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      provideFiles,
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<HermesSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (snapshotSettingsValue) =>
        buildInitialHermesProviderSnapshot(snapshotSettingsValue.provider, initialCatalog).pipe(
          Effect.map(stampIdentity),
        ),
      checkProvider,
      enrichSnapshot: ({
        settings: snapshotSettingsValue,
        snapshot: current,
        getSnapshot,
        publishSnapshot,
      }) =>
        Effect.all(
          [
            resolveMaintenance().pipe(
              Effect.flatMap((maintenanceCapabilities) =>
                enrichHermesSnapshot({
                  snapshot: current,
                  maintenanceCapabilities,
                  enableProviderUpdateChecks: snapshotSettingsValue.enableProviderUpdateChecks,
                  publishSnapshot,
                }),
              ),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            ),
            Stream.fromPubSub(catalogChanges).pipe(
              Stream.runForEach((models) =>
                getSnapshot.pipe(
                  Effect.flatMap((latest) =>
                    publishSnapshot({
                      ...latest,
                      models: [...hermesModelsFromSettings(settings.customModels, models)],
                    }),
                  ),
                ),
              ),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: HERMES_DRIVER_KIND,
            instanceId,
            detail: "Failed to build Hermes snapshot.",
            cause,
          }),
      ),
    );

    const snapshotForCwd = (workspaceCwd: string) =>
      !settings.enabled
        ? snapshot.getSnapshot
        : Effect.gen(function* () {
            // A worktree learns its trust before `hermes skills list` reads it.
            yield* syncHermesWorktreeTrust(settings, processEnv, workspaceCwd).pipe(provideFiles);
            const machineSnapshot = yield* snapshot.getSnapshot;
            const skills = yield* discoverHermesSkillsForCwd(
              settings,
              processEnv,
              workspaceCwd,
            ).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              provideFiles,
            );
            return { ...machineSnapshot, skills };
          });

    /** The one place T3 opens a Hermes session only to read its model catalog. */
    const refreshModels = Effect.fn("HermesDriver.refreshModels")(
      function* () {
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-models-" });
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            cwd,
            clientInfo: { name: "t3-code-provider-models", version: "0.0.0" },
            mcpServers: [],
            spawn: buildHermesAcpSpawnInput({
              settings,
              cwd,
              environment: processEnv,
              homeDirectory,
              yolo: false,
            }),
          }),
        );
        const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
        const started = yield* runtime.start();
        yield* publishCatalog(
          buildHermesModelsFromSessionModelState(started.sessionSetupResult.models),
        );
      },
      Effect.scoped,
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.timeoutOrElse({
        duration: MODEL_REFRESH_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: HERMES_DRIVER_KIND,
              instanceId,
              detail: "Hermes model refresh timed out.",
            }),
          ),
      }),
      Effect.mapError((cause) =>
        cause._tag === "ProviderDriverError"
          ? cause
          : new ProviderDriverError({
              driver: HERMES_DRIVER_KIND,
              instanceId,
              detail: "Could not refresh Hermes models. The previous model list is unchanged.",
              cause,
            }),
      ),
    );

    return {
      instanceId,
      driverKind: HERMES_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd,
      refreshModels,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
