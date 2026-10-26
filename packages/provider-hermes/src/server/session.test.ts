import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { describe, expect } from "vite-plus/test";

import { type HermesRuntimeHandle, HermesRuntimeRegistry } from "./runtime.ts";
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

function makeHandle(promptOpen: boolean) {
  const modes: Array<string> = [];
  const controlPrompts: Array<string> = [];
  const handle = {
    threadId: THREAD,
    runtime: {
      setMode: (modeId: string) => Effect.sync(() => (modes.push(modeId), {})),
    },
    sessionId: () => "hermes-session-1",
    ownPromptOpen: () => promptOpen,
    inject: () => Effect.void,
    controlPrompt: (text: string) =>
      Effect.sync(() => (controlPrompts.push(text), "⏩ Steer queued for the active turn")),
    extensions: {},
  } as unknown as HermesRuntimeHandle;
  return { handle, modes, controlPrompts };
}

const setup = Effect.fn(function* (input: {
  readonly runtimeMode: RuntimeMode;
  readonly promptOpen?: boolean;
  readonly basePending?: boolean;
  readonly pendingBackgroundWork?: (threadId: string) => Effect.Effect<boolean>;
}) {
  const registry = new HermesRuntimeRegistry();
  const runtime = makeHandle(input.promptOpen ?? true);
  yield* registry.register(runtime.handle);
  const startedTurns: Array<RuntimeMode> = [];
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
  return { session, runtime, startedTurns, startTurn, steer };
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
      expect(steerFailureDetail(error)).toContain("has not started this turn");
      expect(runtime.controlPrompts).toEqual([]);
    }),
  );

  it.effect("refuses to steer with attachments", () =>
    Effect.gen(function* () {
      const { runtime, steer } = yield* setup({ runtimeMode: "approval-required" });
      const error = yield* steer("look at this", [{ type: "image" }]).pipe(Effect.flip);
      expect(steerFailureDetail(error)).toContain("attachments");
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
        basePending: false,
        pendingBackgroundWork: (threadId) => Effect.sync(() => daemonWork.has(threadId)),
      });
      expect(yield* session.hasPendingBackgroundWork!).toBe(false);
      daemonWork.add(THREAD);
      expect(yield* session.hasPendingBackgroundWork!).toBe(true);
    }),
  );
});
