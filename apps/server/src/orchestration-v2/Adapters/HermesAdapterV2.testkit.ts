import * as NodeServices from "@effect/platform-node/NodeServices";
import { HermesSettings } from "@t3tools/provider-hermes/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import {
  HERMES_DEFAULT_INSTANCE_ID,
  HERMES_PROVIDER,
  HermesRuntimeRegistry,
  makeHermesAdapterV2,
  makeHermesDelegationWatcher,
} from "@t3tools/provider-hermes/testing";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const DEFAULT_HERMES_SETTINGS = Schema.decodeUnknownSync(HermesSettings)({ enabled: true });

/** The recorder writes this HOME into transcripts, so `MEDIA:` paths resolve the same way. */
const REPLAY_HOME = "/home/hermes-replay";

/** What a replayed delegation reports once its ledger row completes. */
const HERMES_REPLAY_SUBAGENT_RESULT = "SUBAGENT_DONE";

/**
 * Replay has no `state.db`, so the delegation ledger is scripted: a
 * delegation is running when the watcher first reads it, as when Hermes
 * dispatched it, and completed on every later read.
 */
function makeReplayLedger() {
  const seen = new Set<string>();
  return (delegationIds: ReadonlyArray<string>) =>
    Effect.sync(() =>
      delegationIds.map((delegationId) => {
        const first = !seen.has(delegationId);
        seen.add(delegationId);
        return first
          ? { delegationId, state: "running", result: undefined }
          : {
              delegationId,
              state: "completed",
              result: { status: "completed", summary: HERMES_REPLAY_SUBAGENT_RESULT },
            };
      }),
    );
}

function layerHermesProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

  // The delegation watcher lives as long as the registry layer.
  return Layer.unwrap(
    Effect.map(Effect.scope, (scope) =>
      ProviderAdapterRegistry.layerFromAdaptersEffect(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const continuationRequests =
            yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const replayGate = options.replayGate;
          const replayDir = yield* fileSystem
            .makeTempDirectory({
              prefix: `t3-orchestration-v2-hermes-replay-${transcript.scenario}-`,
            })
            .pipe(Effect.orDie);
          const statusPath = path.join(replayDir, "status.json");
          const scriptPath = yield* path
            .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
            .pipe(Effect.orDie);
          const registry = new HermesRuntimeRegistry();
          const delegations = yield* makeHermesDelegationWatcher({
            registry,
            readLedger: makeReplayLedger(),
          });
          const adapter = yield* makeHermesAdapterV2({
            instanceId: HERMES_DEFAULT_INSTANCE_ID,
            registry,
            onDelegationDispatched: delegations.track,
            pendingBackgroundWork: delegations.pendingBackgroundWork,
            settings: DEFAULT_HERMES_SETTINGS,
            // No real Hermes runs, so nothing may read the developer's Hermes home.
            environment: { HERMES_HOME: path.join(replayDir, "hermes-home") },
            homeDirectory: REPLAY_HOME,
            selfInvocation: yield* resolveSelfInvocation(),
            mediaTagOptions: { homeDir: REPLAY_HOME, isFile: () => false },
            makeBaseRuntime: (runtimeInput) =>
              makeAcpReplayRuntime({
                transcript,
                statusPath,
                scriptPath,
                childProcessSpawner,
                fileSystem,
                ...(replayGate === undefined ? {} : { replayGate }),
              })(runtimeInput),
            continuationRequests,
            assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
            ...(replayGate === undefined
              ? {}
              : {
                  testHooks: {
                    onDeferredFinalizeScheduled: (debounce) =>
                      Effect.sync(() => replayGate.recordFinishArmed(debounce)),
                  },
                }),
          });
          return [adapter];
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      ).pipe(
        Layer.provide(Layer.mergeAll(layerHost, NodeServices.layer, IdAllocator.layer)),
        // Held inbound lines must not outlive the scenario and wedge teardown.
        Layer.merge(
          Layer.effectDiscard(
            Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
          ),
        ),
      ),
    ),
  );
}

export const HermesOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: HERMES_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, HERMES_PROVIDER),
  makeProviderAdapterRegistryLayer: layerHermesProviderAdapterRegistryReplay,
};
