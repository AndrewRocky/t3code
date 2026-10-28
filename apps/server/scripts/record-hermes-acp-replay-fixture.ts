import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderReplayEntry } from "@t3tools/contracts";
import { HermesSettings } from "@t3tools/provider-hermes/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  HERMES_DEFAULT_INSTANCE_ID,
  HERMES_PROVIDER,
  HermesRuntimeRegistry,
  makeHermesAdapterV2,
  makeHermesAdmissionReader,
  makeHermesDelegationWatcher,
  makeHermesLedgerReader,
  spawnHermesRuntime,
} from "@t3tools/provider-hermes/testing";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import {
  HERMES_MODEL_SELECTION,
  materializeFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

// Records a live gateway Hermes (`hermes acp`) through T3's real Hermes
// adapter. Run it once per Hermes build, each with its own HERMES_HOME:
//
//   HERMES_HOME=~/.hermes-0.22.5 T3_HERMES_BIN=hermes \
//     pnpm --filter t3 record:hermes-replay --scenario simple,multi_turn
//
// A scenario without a Hermes variant yet is recorded with the ACP variant's
// steps into `<scenario>/hermes_transcript.ndjson`; register it in
// `testkit/fixtures/index.ts` afterwards. `--out <file>` writes elsewhere.

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const HOME_PLACEHOLDER = "/home/hermes-replay";

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface WireMessage {
  readonly direction: "incoming" | "outgoing";
  readonly message: JsonRpcMessage;
}

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
  );
}

function makeWireTee() {
  const wire: Array<WireMessage> = [];
  let runtimeCount = 0;
  const attachRuntime = () => {
    runtimeCount += 1;
    if (runtimeCount > 1) {
      throw new Error("The Hermes recording spawned a second ACP process; replay drives one.");
    }
    let incomingBuffer = "";
    const push = (direction: WireMessage["direction"], line: string) => {
      if (line.trim().length === 0) return;
      wire.push({ direction, message: decodeJson(line) as JsonRpcMessage });
    };
    return {
      logIncoming: true,
      logOutgoing: true,
      logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
        Effect.sync(() => {
          if (event.stage !== "raw" || typeof event.payload !== "string") return;
          if (event.direction === "outgoing") {
            for (const line of event.payload.split("\n")) push("outgoing", line);
            return;
          }
          incomingBuffer += event.payload;
          const lines = incomingBuffer.split("\n");
          incomingBuffer = lines.pop() ?? "";
          for (const line of lines) push("incoming", line);
        }),
    };
  };
  return { wire, attachRuntime };
}

function sessionIdsOf(wire: ReadonlyArray<WireMessage>): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const { message } of wire) {
    if (isRecord(message.result) && typeof message.result.sessionId === "string") {
      ids.add(message.result.sessionId);
    }
    if (isRecord(message.params) && typeof message.params.sessionId === "string") {
      ids.add(message.params.sessionId);
    }
  }
  return [...ids];
}

/**
 * Hermes sends no busy signal over ACP and runs delegation results as turns
 * of its own, so the daemon's tables say when it is done: no admission of the
 * recorded sessions is queued, started or lost, and no delegation they
 * started still runs or waits to deliver its result.
 */
type HermesPendingWork =
  | { readonly admissions: number; readonly delegations: number }
  | { readonly unreadable: unknown };

function hermesPendingWork(
  stateDbPath: string,
  sessionIds: ReadonlyArray<string>,
): HermesPendingWork {
  if (sessionIds.length === 0) return { admissions: 0, delegations: 0 };
  const placeholders = sessionIds.map(() => "?").join(", ");
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(stateDbPath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const admissions = database
      .prepare(
        `SELECT COUNT(*) AS count FROM session_admissions
         WHERE target_session_id IN (${placeholders}) AND status IN ('queued', 'started', 'unknown')`,
      )
      .get(...sessionIds);
    const delegations = database
      .prepare(
        `SELECT COUNT(*) AS count FROM async_delegations
         WHERE parent_session_id IN (${placeholders})
           AND (state IN ('running', 'stalling', 'finalizing') OR delivery_state = 'pending')`,
      )
      .get(...sessionIds);
    return {
      admissions: Number(admissions?.count ?? 0),
      delegations: Number(delegations?.count ?? 0),
    };
  } catch (cause) {
    return { unreadable: cause };
  } finally {
    database?.close();
  }
}

function frameLabel(kind: string, method: string, params: unknown): string {
  const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
  const updateType = typeof update?.sessionUpdate === "string" ? `:${update.sessionUpdate}` : "";
  return `${kind}:${method}${updateType}`;
}

function wireToEntries(wire: ReadonlyArray<WireMessage>): {
  readonly entries: Array<ProviderReplayEntry>;
  readonly droppedFrames: number;
} {
  const entries: Array<ProviderReplayEntry> = [];
  const t3Requests = new Map<string, string>();
  const agentRequests = new Map<string, string>();
  let droppedFrames = 0;
  for (const { direction, message } of wire) {
    const type = direction === "outgoing" ? "expect_outbound" : "emit_inbound";
    if (typeof message.method === "string") {
      const isRequest = message.id !== undefined && message.id !== null;
      if (isRequest) {
        (direction === "outgoing" ? t3Requests : agentRequests).set(
          String(message.id),
          message.method,
        );
      }
      const kind = isRequest ? "request" : "notification";
      entries.push({
        type,
        label: frameLabel(kind, message.method, message.params),
        frame: {
          kind,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
      });
      continue;
    }
    const pending = direction === "outgoing" ? agentRequests : t3Requests;
    const method = pending.get(String(message.id));
    if (method === undefined) {
      droppedFrames += 1;
      continue;
    }
    pending.delete(String(message.id));
    entries.push({
      type,
      label: `response:${method}`,
      frame: {
        kind: "response",
        method,
        ...(message.result === undefined ? {} : { result: message.result }),
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    });
  }
  return { entries, droppedFrames };
}

const T3_INSTRUCTIONS_BODY = /<t3_code_instructions>\n[\s\S]*?\n<\/t3_code_instructions>/u;

function normalizeOutboundFrame(frame: Record<string, unknown>, runtimeInstructions: string) {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (params === undefined) return frame;
  switch (frame.method) {
    case "initialize":
      return {
        ...frame,
        params: Object.fromEntries(
          Object.keys(params).map((key) => [
            key,
            key === "protocolVersion" || key === "_meta" ? params[key] : "<any>",
          ]),
        ),
      };
    case "session/new":
    case "session/load":
    case "session/resume":
      return { ...frame, params: { ...params, mcpServers: "<any>" } };
    case "session/prompt": {
      if (!Array.isArray(params.prompt)) return frame;
      const prompt = params.prompt.filter(
        (part) => !(isRecord(part) && part.type === "text" && part.text === runtimeInstructions),
      );
      return {
        ...frame,
        params: {
          ...params,
          prompt: prompt.map((part) =>
            isRecord(part) && typeof part.text === "string"
              ? {
                  ...part,
                  text: part.text.replace(
                    T3_INSTRUCTIONS_BODY,
                    "<t3_code_instructions>\n<any>\n</t3_code_instructions>",
                  ),
                }
              : part,
          ),
        },
      };
    }
    default:
      return frame;
  }
}

function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly sessionIds: ReadonlyArray<string>;
  readonly workspace: string;
  readonly home: string;
  readonly user: string;
  readonly runtimeInstructions: string;
}): Array<ProviderReplayEntry> {
  const replacements: Array<readonly [string, string]> = [
    ...input.sessionIds.map(
      (id, index) =>
        [id, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`] as const,
    ),
    [input.workspace, "<workspace>"],
    [encodeURIComponent(input.workspace), "%3Cworkspace%3E"],
    [input.home, HOME_PLACEHOLDER],
  ];
  const user = /^[a-z_][a-z0-9_-]*$/iu.test(input.user) ? input.user : "";
  const userPattern = user.length === 0 ? undefined : new RegExp(`\\b${user}\\b`, "gu");
  const replaceAll = (text: string) => {
    const replaced = replacements.reduce(
      (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
      text,
    );
    return userPattern === undefined ? replaced : replaced.replace(userPattern, "hermes-replay");
  };
  return input.entries.map((entry) => {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) return entry;
    const frame =
      entry.type === "expect_outbound"
        ? normalizeOutboundFrame(entry.frame, input.runtimeInstructions)
        : entry.frame;
    return {
      ...entry,
      ...(entry.label === undefined ? {} : { label: replaceAll(entry.label) }),
      frame: mapStrings(frame, replaceAll),
    };
  });
}

/** Scenarios Hermes has no variant for yet borrow the ACP variant's shape. */
function hermesVariantOf(
  providers: ReadonlyArray<ProviderOrchestratorReplayVariant>,
): ProviderOrchestratorReplayVariant | undefined {
  const own = providers.find((provider) => provider.driver === HERMES_PROVIDER);
  if (own !== undefined) return own;
  const template =
    providers.find((provider) => provider.driver === "acpRegistry") ??
    providers.find((provider) => provider.driver === "grok");
  if (template === undefined) return undefined;
  return {
    ...template,
    driver: HERMES_PROVIDER,
    transcriptFile: new URL("hermes_transcript.ndjson", template.transcriptFile),
    modelSelection: HERMES_MODEL_SELECTION,
  };
}

const DEFAULT_HERMES_SETTINGS = Schema.decodeUnknownSync(HermesSettings)({ enabled: true });

const recordScenario = Effect.fn("recordHermesScenario")(function* (fixtureName: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  const variant = fixture === undefined ? undefined : hermesVariantOf(fixture.providers);
  if (fixture === undefined || variant === undefined) {
    return yield* Effect.die(new Error(`No ACP replay fixture named '${fixtureName}'.`));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const fixtureInput = fixture.buildInput();
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: HERMES_PROVIDER,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${fixtureName}/hermes-record`,
    commands: materialized.commands,
    // Live, Hermes and wall time pace themselves: a gated fixture records its
    // dispatches only, then waits for Hermes to idle.
    steps: materialized.steps.some(
      (step) =>
        step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting",
    )
      ? materialized.steps.filter((step) => step.type === "dispatch")
      : materialized.steps.map((step) =>
          step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step,
        ),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: realWorkspace },
  };

  const tee = makeWireTee();
  const settings = {
    ...DEFAULT_HERMES_SETTINGS,
    binaryPath: process.env.T3_HERMES_BIN ?? "hermes",
  };
  const hermesHome = environment.HERMES_HOME?.trim() || path.join(homeDirectory, ".hermes");
  const stateDbPath = path.join(hermesHome, "state.db");
  const spawnOptions = { settings, environment, homeDirectory };
  // The delegation watcher lives as long as the registry layer.
  const layerRegistry = Layer.unwrap(
    Effect.map(Effect.scope, (scope) =>
      ProviderAdapterRegistry.layerFromAdaptersEffect(
        Effect.gen(function* () {
          // The scenario runs on the replay TestClock so its clock steps order
          // dispatches as replay will. Hermes runs on wall time, so the adapter's
          // session (control-prompt timeouts, finish debounces) and the ledger
          // watcher do too.
          const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.provideService(effect, Clock.Clock, wallClock);
          // Wired as the driver wires it, so recordings follow Hermes' work the same way.
          const registry = new HermesRuntimeRegistry();
          const delegations = yield* onWallClock(
            makeHermesDelegationWatcher({
              registry,
              readLedger: makeHermesLedgerReader(stateDbPath),
            }),
          );
          const adapter = yield* makeHermesAdapterV2({
            instanceId: HERMES_DEFAULT_INSTANCE_ID,
            ...spawnOptions,
            registry,
            onDelegationDispatched: delegations.track,
            pendingBackgroundWork: delegations.pendingBackgroundWork,
            readAdmissions: makeHermesAdmissionReader(stateDbPath),
            selfInvocation: yield* resolveSelfInvocation(),
            continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
            makeBaseRuntime: (input, launch) =>
              spawnHermesRuntime(
                spawnOptions,
                { ...input, protocolLogging: tee.attachRuntime() },
                launch,
              ),
          });
          return [
            {
              ...adapter,
              openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
                adapter.openSession(input).pipe(
                  Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
                    ...session,
                    startTurn: (turnInput) => onWallClock(session.startTurn(turnInput)),
                    steerTurn: (turnInput) => onWallClock(session.steerTurn(turnInput)),
                    interruptTurn: (turnInput) => onWallClock(session.interruptTurn(turnInput)),
                    respondToRuntimeRequest: (turnInput) =>
                      onWallClock(session.respondToRuntimeRequest(turnInput)),
                  })),
                  onWallClock,
                ),
            },
          ];
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
            NodeServices.layer,
            IdAllocator.layer,
          ),
        ),
      ),
    ),
  );

  // A delegation result is admitted a moment after the child finishes, so
  // Hermes must also stay quiet for a few seconds.
  let quietPolls = 0;
  let seenFrames = -1;
  let lastReport = "";
  const waitForHermesIdle = Effect.sleep("1 second").pipe(
    Effect.andThen(
      Effect.gen(function* () {
        quietPolls = seenFrames === tee.wire.length ? quietPolls + 1 : 0;
        seenFrames = tee.wire.length;
        const pending = hermesPendingWork(stateDbPath, sessionIdsOf(tee.wire));
        const report =
          "unreadable" in pending ? "unreadable" : `${pending.admissions}/${pending.delegations}`;
        if (report !== lastReport) {
          lastReport = report;
          yield* "unreadable" in pending
            ? Console.warn(
                `Cannot read ${stateDbPath}; waiting on quiet alone.`,
                pending.unreadable,
              )
            : Console.log(`Hermes work still pending in ${stateDbPath}:`, pending);
        }
        const busy = !("unreadable" in pending) && pending.admissions + pending.delegations > 0;
        return quietPolls >= 5 && !busy;
      }),
    ),
    Effect.repeat({ until: (idle) => idle }),
    Effect.timeout("10 minutes"),
    Effect.orDie,
    Effect.asVoid,
    Effect.provideService(Clock.Clock, wallClock),
  );
  const result = yield* runOrchestratorV2Scenario(scenario, { afterSteps: waitForHermesIdle }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        scenario,
        layerRegistry,
        variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
      ),
    ),
    provideDeterministicTestRuntime,
    Effect.scoped,
  );

  const { entries, droppedFrames } = wireToEntries(tee.wire);
  const initialize = entries.find(
    (entry) =>
      entry.type === "emit_inbound" && isRecord(entry.frame) && entry.frame.method === "initialize",
  );
  const agentInfo =
    initialize?.type === "emit_inbound" &&
    isRecord(initialize.frame) &&
    isRecord(initialize.frame.result) &&
    isRecord(initialize.frame.result.agentInfo)
      ? initialize.frame.result.agentInfo
      : {};
  const transcript = {
    provider: HERMES_PROVIDER,
    protocol: ACP_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-hermes-recorder",
      hermesVersion: agentInfo.version ?? "unknown",
      normalization:
        "Session ids are fixed UUIDs, the workspace is <workspace>, HOME is /home/hermes-replay and the recording user is hermes-replay. T3-owned prompt text, MCP servers and initialize params other than protocolVersion and _meta are <any>. Timestamps are kept as recorded.",
      droppedFrames,
    },
    entries: [
      ...normalizeEntries({
        entries,
        sessionIds: sessionIdsOf(tee.wire),
        workspace: realWorkspace,
        home: homeDirectory,
        user: process.env.USER ?? "",
        runtimeInstructions: buildRuntimeInstructions({
          harness: "Hermes",
          model: variant.modelSelection.model,
        }),
      }),
      // Hermes advertises no session/close; the viewer ends when T3 closes stdin.
      { type: "runtime_exit", status: "success" } as const,
    ],
  };

  const outputPath = readArgValues("--out")[0] ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const { entries: transcriptEntries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...transcriptEntries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  yield* Console.log(
    `Wrote ${transcriptEntries.length} Hermes ACP replay entries to ${outputPath}`,
  );

  const liveFailure = yield* Effect.try(() => variant.assertOutput(result, transcript)).pipe(
    Effect.flip,
    Effect.option,
  );
  if (liveFailure._tag === "Some") {
    yield* Console.log(`Live orchestration failed ${fixtureName} assertions:`, liveFailure.value);
  }
});

const scenarios = readArgValues("--scenario").flatMap((value) => value.split(","));
if (scenarios.length === 0) {
  throw new Error("Pass --scenario <fixture name>[,<fixture name>...]");
}

await Effect.runPromise(
  Effect.forEach(scenarios, (name) => Effect.scoped(recordScenario(name)), {
    discard: true,
  }).pipe(Effect.provide(NodeServices.layer)),
);
