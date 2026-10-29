import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { describe, expect } from "vite-plus/test";

import {
  type HermesRuntimeHandle,
  HermesRuntimeRegistry,
  type HermesWorkState,
} from "./runtime.ts";
import { decorateHermesAdapter } from "./session.ts";

type Adapter = ProviderAdapter.ProviderAdapterV2["Service"];
type Session = ProviderAdapter.ProviderAdapterV2SessionRuntime;
type RuntimeMode = ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"];

const THREAD = "thread-1";

const policy = (runtimeMode: RuntimeMode): ProviderAdapter.ProviderAdapterV2RuntimePolicy => ({
  runtimeMode,
  interactionMode: "default",
  cwd: "/repo",
});

const approval = {
  type: "approval_request",
  id: "item-1",
  requestId: "request-1",
  title: "Write ~/.ssh/config",
} as const;

function makeHandle(input: {
  readonly promptOpen: boolean;
  readonly workState: HermesWorkState;
  readonly queued?: number;
}) {
  const modes: Array<string> = [];
  const controlPrompts: Array<string> = [];
  const stops: Array<unknown> = [];
  const handle = {
    threadId: THREAD,
    runtime: {
      setMode: (modeId: string) => Effect.sync(() => (modes.push(modeId), {})),
    },
    sessionId: () => "hermes-session-1",
    ownPromptOpen: () => input.promptOpen,
    workState: () => Effect.succeed(input.workState),
    queuedAdmissions: () => Effect.succeed(input.queued ?? 0),
    stopOwnTurn: (bound: unknown) => Effect.sync(() => (stops.push(bound), true)),
    inject: () => Effect.void,
    controlPrompt: (text: string) =>
      Effect.sync(() => (controlPrompts.push(text), "⏩ Steer queued for the active turn")),
    extensions: {},
  } as unknown as HermesRuntimeHandle;
  return { handle, modes, controlPrompts, stops };
}

const setup = Effect.fn(function* (input: {
  readonly runtimeMode: RuntimeMode;
  readonly promptOpen?: boolean;
  readonly workState?: HermesWorkState;
  readonly queued?: number;
  readonly basePending?: boolean;
  readonly pendingBackgroundWork?: (threadId: string) => Effect.Effect<boolean>;
}) {
  const registry = new HermesRuntimeRegistry();
  const promptOpen = input.promptOpen ?? true;
  const runtime = makeHandle({
    promptOpen,
    workState: input.workState ?? (promptOpen ? "own" : "idle"),
    ...(input.queued === undefined ? {} : { queued: input.queued }),
  });
  yield* registry.register(runtime.handle);
  const startedTurns: Array<RuntimeMode> = [];
  const baseCalls: Array<string> = [];
  const baseSession = {
    events: Stream.fromIterable([
      { type: "turn_item.updated", turnItem: approval },
      { type: "turn_item.updated", turnItem: { type: "assistant_message", id: "item-2" } },
    ]),
    ...(input.basePending === undefined
      ? {}
      : { hasPendingBackgroundWork: Effect.succeed(input.basePending) }),
    startTurn: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.sync(() => void startedTurns.push(turn.runtimePolicy.runtimeMode)),
    steerTurn: () => Effect.die("the shared steer must not run for Hermes"),
    interruptTurn: () => Effect.sync(() => void baseCalls.push("interruptTurn")),
    rollbackThread: () => Effect.sync(() => (baseCalls.push("rollbackThread"), {})),
  } as unknown as Session;
  const adapter = decorateHermesAdapter(
    { openSession: () => Effect.succeed(baseSession) } as unknown as Adapter,
    {
      registry,
      ...(input.pendingBackgroundWork === undefined
        ? {}
        : { pendingBackgroundWork: input.pendingBackgroundWork }),
    },
  );
  const session = yield* adapter.openSession({
    threadId: THREAD,
    runtimePolicy: policy(input.runtimeMode),
  } as unknown as ProviderAdapter.ProviderAdapterV2OpenSessionInput);
  const startTurn = (runtimeMode: RuntimeMode) =>
    session.startTurn({
      runtimePolicy: policy(runtimeMode),
    } as unknown as ProviderAdapter.ProviderAdapterV2TurnInput);
  const steer = (text: string, attachments: ReadonlyArray<unknown> = []) =>
    session.steerTurn({
      threadId: THREAD,
      providerThread: { id: "provider-thread-1" },
      providerTurnId: "provider-turn-1",
      message: { text, attachments },
    } as unknown as ProviderAdapter.ProviderAdapterV2SteerInput);
  const interrupt = () =>
    session.interruptTurn({
      providerThread: { id: "provider-thread-1" },
      providerTurnId: "provider-turn-1",
      requestRuntimeRestart: true,
    } as unknown as ProviderAdapter.ProviderAdapterV2InterruptInput);
  const rollback = () =>
    session.rollbackThread({
      providerThread: { id: "provider-thread-1" },
    } as unknown as ProviderAdapter.ProviderAdapterV2RollbackThreadInput);
  return { session, runtime, startedTurns, baseCalls, startTurn, steer, interrupt, rollback };
});

const steerFailureDetail = (error: unknown) =>
  (error as { readonly cause?: { readonly message?: string } }).cause?.message;

describe("decorateHermesAdapter", () => {
  it.effect("applies a changed permission mode before the turn's prompt", () =>
    Effect.gen(function* () {
      const { runtime, startedTurns, startTurn } = yield* setup({
        runtimeMode: "approval-required",
      });
      yield* startTurn("approval-required");
      yield* startTurn("full-access");
      yield* startTurn("full-access");
      yield* startTurn("auto-accept-edits");
      expect(runtime.modes).toEqual(["dont_ask", "accept_edits"]);
      expect(startedTurns).toEqual([
        "approval-required",
        "full-access",
        "full-access",
        "auto-accept-edits",
      ]);
    }),
  );

  it.effect("tells the runtime a restart-recovery turn is starting, until it fails", () =>
    Effect.gen(function* () {
      const registry = new HermesRuntimeRegistry();
      const seen: Array<boolean> = [];
      const failing = { fail: false };
      const adapter = decorateHermesAdapter(
        {
          openSession: () =>
            Effect.succeed({
              events: Stream.empty,
              startTurn: () =>
                Effect.suspend(() => {
                  seen.push(registry.restartRecoveryPending(THREAD));
                  return failing.fail ? Effect.fail("activation failed") : Effect.void;
                }),
            } as unknown as Session),
        } as unknown as Adapter,
        { registry },
      );
      const session = yield* adapter.openSession({
        threadId: THREAD,
        runtimePolicy: policy("approval-required"),
      } as unknown as ProviderAdapter.ProviderAdapterV2OpenSessionInput);
      const turn = (restartContinuationOfRunId?: string) =>
        session.startTurn({
          threadId: THREAD,
          runtimePolicy: policy("approval-required"),
          ...(restartContinuationOfRunId === undefined ? {} : { restartContinuationOfRunId }),
        } as unknown as ProviderAdapter.ProviderAdapterV2TurnInput);

      yield* turn();
      yield* turn("run-1");
      failing.fail = true;
      yield* turn("run-2").pipe(Effect.flip);
      expect(seen).toEqual([false, true, true]);
      expect(registry.restartRecoveryPending(THREAD)).toBe(false);
    }),
  );

  it.effect("steers through Hermes' /steer while its own prompt is open", () =>
    Effect.gen(function* () {
      const { runtime, steer } = yield* setup({ runtimeMode: "approval-required" });
      yield* steer("also cover the empty case");
      expect(runtime.controlPrompts).toEqual(["/steer also cover the empty case"]);
    }),
  );

  it.effect("refuses to steer a turn Hermes has not started for this viewer", () =>
    Effect.gen(function* () {
      const { runtime, steer } = yield* setup({
        runtimeMode: "approval-required",
        promptOpen: false,
      });
      const error = yield* steer("also cover the empty case").pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterSteerRunError");
      expect(steerFailureDetail(error)).toContain("did not start");
      expect(error).toMatchObject({ queueAsFollowUp: true });
      expect(runtime.controlPrompts).toEqual([]);
    }),
  );

  it.effect("refuses to steer while other prompts are queued ahead of T3's", () =>
    Effect.gen(function* () {
      const { runtime, steer } = yield* setup({ runtimeMode: "approval-required", queued: 1 });
      const error = yield* steer("also cover the empty case").pipe(Effect.flip);
      expect(steerFailureDetail(error)).toContain("did not start");
      expect(error).toMatchObject({ queueAsFollowUp: true });
      expect(runtime.controlPrompts).toEqual([]);
    }),
  );

  it.effect("refuses to stop a turn this session did not start, and stops its own", () =>
    Effect.gen(function* () {
      const foreign = yield* setup({
        runtimeMode: "approval-required",
        promptOpen: false,
        workState: "foreign",
      });
      const error = yield* foreign.interrupt().pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterInterruptError");
      expect(steerFailureDetail(error)).toContain("did not start");
      // The effect worker settles a Stop whose failure reads as already stopped.
      expect(steerFailureDetail(error)).not.toMatch(/is not active|treating as already/i);
      expect(foreign.baseCalls).toEqual([]);

      const own = yield* setup({ runtimeMode: "approval-required" });
      yield* own.interrupt();
      expect(own.baseCalls).toEqual(["interruptTurn"]);
    }),
  );

  it.effect("refuses to roll back while Hermes works", () =>
    Effect.gen(function* () {
      const busy = yield* setup({
        runtimeMode: "approval-required",
        promptOpen: false,
        workState: "foreign",
      });
      const error = yield* busy.rollback().pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRollbackThreadError");
      expect(busy.baseCalls).toEqual([]);

      const idle = yield* setup({ runtimeMode: "approval-required", promptOpen: false });
      yield* idle.rollback();
      expect(idle.baseCalls).toEqual(["rollbackThread"]);
    }),
  );

  it.effect("stops T3's own turn before the session is released", () =>
    Effect.gen(function* () {
      const { runtime } = yield* setup({ runtimeMode: "approval-required" }).pipe(Effect.scoped);
      expect(runtime.stops).toEqual(["3 seconds"]);

      const idle = yield* setup({ runtimeMode: "approval-required", promptOpen: false }).pipe(
        Effect.scoped,
      );
      expect(idle.runtime.stops).toEqual([]);
    }),
  );

  it.effect("refuses to steer with attachments", () =>
    Effect.gen(function* () {
      const { runtime, steer } = yield* setup({ runtimeMode: "approval-required" });
      const error = yield* steer("look at this", [{ type: "image" }]).pipe(Effect.flip);
      expect(steerFailureDetail(error)).toContain("attachments");
      expect(error).toMatchObject({ queueAsFollowUp: true });
      expect(runtime.controlPrompts).toEqual([]);
    }),
  );

  it.effect("marks approvals Hermes still asks for in Full access", () =>
    Effect.gen(function* () {
      const fullAccess = yield* setup({ runtimeMode: "full-access" });
      const [stamped, untouched] = yield* Stream.runCollect(fullAccess.session.events);
      expect(stamped).toMatchObject({
        turnItem: { type: "approval_request", fullAccessOverride: "provider_check" },
      });
      expect(untouched).toMatchObject({ turnItem: { type: "assistant_message" } });

      const supervised = yield* setup({ runtimeMode: "approval-required" });
      const [plain] = yield* Stream.runCollect(supervised.session.events);
      expect(plain).toMatchObject({ turnItem: approval });
      expect(plain).not.toHaveProperty("turnItem.fullAccessOverride");
    }),
  );

  it.effect("reports Hermes' background work alongside the adapter's", () =>
    Effect.gen(function* () {
      const daemonWork = new Set<string>();
      const { session } = yield* setup({
        runtimeMode: "approval-required",
        promptOpen: false,
        basePending: false,
        pendingBackgroundWork: (threadId) => Effect.sync(() => daemonWork.has(threadId)),
      });
      expect(yield* session.hasPendingBackgroundWork!).toBe(false);
      daemonWork.add(THREAD);
      expect(yield* session.hasPendingBackgroundWork!).toBe(true);

      const busy = yield* setup({
        runtimeMode: "approval-required",
        promptOpen: false,
        workState: "foreign",
      });
      expect(yield* busy.session.hasPendingBackgroundWork!).toBe(true);
    }),
  );
});
