import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { HermesSettings } from "../settings.ts";
import { HermesDriver } from "./driver.ts";

const decodeSettings = Schema.decodeUnknownSync(HermesSettings);

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

/** Every command fails, so the status probe never reaches Hermes. */
const failingSpawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(2)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

it.layer(layerTest)("HermesDriver model catalog", (it) => {
  // The provider registry treats a ready snapshot's models as the full list and forgets the rest,
  // so a ready Hermes snapshot must never go out without the catalog saved from earlier sessions.
  it.effect("lists the saved catalog in every snapshot, starting with the first", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const instanceId = ProviderInstanceId.make("hermes-saved");
      const catalogDirectory = path.join(host.paths.stateDir, "provider-hermes");
      yield* fileSystem.makeDirectory(catalogDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(catalogDirectory, `${instanceId}-models.json`),
        JSON.stringify([{ slug: "custom:llm_router:rnd-glm", name: "rnd-glm" }]),
      );

      const instance = yield* HermesDriver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [],
        config: decodeSettings({}),
      }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingSpawner),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("The catalog check makes no HTTP requests")),
        ),
      );

      const initial = yield* instance.snapshot.getSnapshot;
      assert.notStrictEqual(initial.status, "ready");
      assert.include(
        initial.models.map((model) => model.slug),
        "custom:llm_router:rnd-glm",
      );
      const probed = yield* instance.snapshot.refresh;
      assert.include(
        probed.models.map((model) => model.slug),
        "custom:llm_router:rnd-glm",
      );
    }),
  );
});
