import { it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { describe, expect } from "vite-plus/test";

import { HERMES_STOP_UNCONFIRMED_CODE, makeHermesRuntime } from "./runtime.ts";
import type { HermesAdmissions } from "./workState.ts";

// Stop and work state against a fake viewer whose prompt returns only when
// the test says Hermes stopped.

type Notification = EffectAcpSchema.SessionNotification;
type Handler = (notification: Notification) => Effect.Effect<void, EffectAcpErrors.AcpError>;
type Update = Notification["update"];

const SESSION = "hermes-session-1";
const IDLE: HermesAdmissions = { queued: 0, started: 0, lost: [] };
const BUSY: HermesAdmissions = { queued: 0, started: 1, lost: [] };

const turnText = (text: string): Update => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  messageId: "msg-1",
});

const setup = Effect.fn(function* (input: {
  readonly followWorkState?: boolean;
  /** What each admissions read returns, in order; the last one repeats. */
  readonly admissions?: ReadonlyArray<HermesAdmissions | undefined>;
  /** Frames Hermes replays while a session loads. */
  readonly replay?: ReadonlyArray<Update>;
  readonly deferredMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  /** T3's restart recovery is starting a turn on this thread. */
  readonly restartRecovery?: boolean;
}) {
  let recovery = input.restartRecovery === true;
  const loads: Array<unknown> = [];
  let prompts = 0;
  let baseHandler: Handler | undefined;
  const cancels = yield* Queue.unbounded<void>();
  const promptStarted = yield* Queue.unbounded<void>();
  const promptReturn = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
  const emit = (update: Update) =>
    baseHandler === undefined ? Effect.void : baseHandler({ sessionId: SESSION, update });
  const started = {
    sessionId: SESSION,
    initializeResult: { protocolVersion: 1 },
    sessionSetupResult: {},
    modelConfigId: undefined,
  };
  const base = {
    handleSessionUpdate: (handler: Handler) =>
      Effect.sync(() => {
        baseHandler = handler;
      }),
    start: () => Effect.succeed(started),
    loadSession: (_id: string, activation: unknown) =>
      Effect.sync(() => loads.push(activation)).pipe(
        Effect.andThen(Effect.forEach(input.replay ?? [], emit, { discard: true })),
        Effect.as(started),
      ),
    prompt: () =>
      Effect.sync(() => (prompts += 1)).pipe(
        Effect.andThen(Queue.offer(promptStarted, undefined)),
        Effect.andThen(Deferred.await(promptReturn)),
      ),
    cancel: Queue.offer(cancels, undefined).pipe(Effect.asVoid),
  } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

  let reads = 0;
  const handle = yield* makeHermesRuntime(base, {
    threadId: "thread-1",
    cwd: "/repo",
    launchYolo: false,
    skillNames: () => Effect.succeed([]),
    mediaTagOptions: { homeDir: "/home/me", isFile: () => false },
    followWorkState: input.followWorkState ?? false,
    ...(input.deferredMcpServers === undefined
      ? {}
      : { deferredMcpServers: input.deferredMcpServers }),
    restartRecoveryPending: () => recovery,
    clearRestartRecovery: () => {
      recovery = false;
    },
    readAdmissions: () =>
      Effect.sync(() => {
        const answers = input.admissions ?? [IDLE];
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        return answer;
      }),
  });
  const delivered = yield* Queue.unbounded<Update>();
  yield* handle.runtime.handleSessionUpdate((notification) =>
    Queue.offer(delivered, notification.update).pipe(Effect.asVoid),
  );
  const startPrompt = () =>
    handle.runtime
      .prompt({ prompt: [{ type: "text", text: "refactor the parser" }] })
      .pipe(Effect.forkChild);
  return {
    handle,
    emit,
    cancels,
    promptStarted,
    promptReturn,
    delivered,
    startPrompt,
    loads,
    prompts: () => prompts,
  };
});

const takeAll = <A>(queue: Queue.Queue<A>) => Queue.clear(queue);

describe("Hermes Stop", () => {
  it.effect(
    "keeps nudging session/cancel and reports the Stop once Hermes returns the prompt",
    () =>
      Effect.gen(function* () {
        const fake = yield* setup({});
        yield* fake.handle.runtime.start();
        const prompt = yield* fake.startPrompt();
        yield* Queue.take(fake.promptStarted);

        const stop = yield* fake.handle.runtime.cancel.pipe(Effect.forkChild);
        yield* Queue.take(fake.cancels);
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(fake.cancels);
        yield* Deferred.succeed(fake.promptReturn, { stopReason: "cancelled" });

        yield* Fiber.join(stop);
        expect((yield* Fiber.join(prompt)).stopReason).toBe("cancelled");
        expect(fake.handle.ownPromptOpen()).toBe(false);
      }),
  );

  it.effect("fails an unconfirmed Stop without giving up the turn", () =>
    Effect.gen(function* () {
      const fake = yield* setup({});
      yield* fake.handle.runtime.start();
      yield* fake.startPrompt();
      yield* Queue.take(fake.promptStarted);

      const stop = yield* fake.handle.runtime.cancel.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("45 seconds");
      const error = yield* Fiber.join(stop);
      expect(error).toMatchObject({ code: HERMES_STOP_UNCONFIRMED_CODE });
      expect(fake.handle.ownPromptOpen()).toBe(true);
      expect((yield* takeAll(fake.cancels)).length).toBeGreaterThan(10);
    }),
  );

  it.effect("leaves the tool a Stop cut short open instead of failed", () =>
    Effect.gen(function* () {
      const failedTool: Update = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "failed",
      };
      const fake = yield* setup({});
      yield* fake.handle.runtime.start();
      yield* fake.startPrompt();
      yield* Queue.take(fake.promptStarted);
      yield* fake.emit(failedTool);
      expect(yield* Queue.take(fake.delivered)).toMatchObject({ status: "failed" });

      const stop = yield* fake.handle.runtime.cancel.pipe(Effect.forkChild);
      yield* Queue.take(fake.cancels);
      yield* fake.emit(failedTool);
      expect(yield* Queue.take(fake.delivered)).toMatchObject({ status: "in_progress" });
      yield* Deferred.succeed(fake.promptReturn, { stopReason: "cancelled" });
      yield* Fiber.join(stop);
    }),
  );

  it.effect("refuses to close the session over work another client started", () =>
    Effect.gen(function* () {
      const busy = yield* setup({ admissions: [BUSY] });
      yield* busy.handle.runtime.start();
      const error = yield* busy.handle.runtime.closeSession().pipe(Effect.flip);
      expect(error).toMatchObject({ code: HERMES_STOP_UNCONFIRMED_CODE });
      expect(yield* busy.handle.workState()).toBe("foreign");

      const idle = yield* setup({ admissions: [IDLE] });
      yield* idle.handle.runtime.start();
      expect(yield* idle.handle.runtime.closeSession()).toEqual({});
    }),
  );
});

describe("Hermes work state", () => {
  it.effect("reports a v2 agent and brackets its own turn with accept and idle", () =>
    Effect.gen(function* () {
      const fake = yield* setup({ followWorkState: true });
      const started = yield* fake.handle.runtime.start();
      expect(started.initializeResult.protocolVersion).toBe(2);

      const prompt = yield* fake.startPrompt();
      yield* Queue.take(fake.promptStarted);
      yield* fake.emit(turnText("done"));
      yield* Deferred.succeed(fake.promptReturn, { stopReason: "end_turn" });
      yield* Fiber.join(prompt);

      expect(yield* takeAll(fake.delivered)).toEqual([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "" } },
        turnText("done"),
        { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      ]);
    }),
  );

  it.effect("follows work Hermes queued behind T3's turn until the store says idle", () =>
    Effect.gen(function* () {
      // start, turn end (busy), first poll (busy), second poll (idle)
      const fake = yield* setup({ followWorkState: true, admissions: [IDLE, BUSY, BUSY, IDLE] });
      yield* fake.handle.runtime.start();
      const prompt = yield* fake.startPrompt();
      yield* Queue.take(fake.promptStarted);
      yield* Deferred.succeed(fake.promptReturn, { stopReason: "end_turn" });
      yield* Fiber.join(prompt);
      yield* takeAll(fake.delivered);
      expect(yield* fake.handle.workState()).toBe("foreign");

      yield* fake.emit(turnText("delegation results"));
      yield* TestClock.adjust("1 second");
      expect(yield* fake.handle.workState()).toBe("foreign");
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(fake.delivered)).toEqual(turnText("delegation results"));
      expect(yield* Queue.take(fake.delivered)).toEqual({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      });
      expect(yield* fake.handle.workState()).toBe("idle");
    }),
  );

  it.effect("starts a run for frames Hermes sends with no turn open", () =>
    Effect.gen(function* () {
      const fake = yield* setup({ followWorkState: true, admissions: [IDLE, BUSY, IDLE] });
      yield* fake.handle.runtime.start();
      yield* fake.emit(turnText("from Hermes Desktop"));
      expect(yield* takeAll(fake.delivered)).toEqual([
        { sessionUpdate: "state_update", state: "running" },
        turnText("from Hermes Desktop"),
      ]);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(fake.delivered)).toMatchObject({ state: "idle" });
    }),
  );

  it.effect("settles work it cannot see in the store once Hermes goes quiet", () =>
    Effect.gen(function* () {
      const fake = yield* setup({ followWorkState: true, admissions: [undefined] });
      yield* fake.handle.runtime.start();
      yield* fake.emit(turnText("from Hermes Desktop"));
      yield* takeAll(fake.delivered);
      yield* TestClock.adjust("4 seconds");
      expect(yield* takeAll(fake.delivered)).toEqual([]);
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(fake.delivered)).toMatchObject({ state: "idle" });
    }),
  );

  it.effect(
    "keeps a replayed transcript out of the adapter and shows earlier work still running",
    () =>
      Effect.gen(function* () {
        const fake = yield* setup({
          followWorkState: true,
          admissions: [BUSY],
          replay: [
            { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier" } },
            turnText("earlier answer"),
            { sessionUpdate: "available_commands_update", availableCommands: [] },
          ],
        });
        yield* fake.handle.runtime.loadSession(SESSION, { cwd: "/repo", mcpServers: [] } as never);
        expect(yield* takeAll(fake.delivered)).toEqual([
          { sessionUpdate: "available_commands_update", availableCommands: [] },
          { sessionUpdate: "state_update", state: "running" },
        ]);
      }),
  );
});

describe("Hermes after a T3 restart", () => {
  const T3_TOOLS: ReadonlyArray<EffectAcpSchema.McpServer> = [
    { name: "t3-code", command: "t3", args: ["acp-mcp-bridge"], env: [] },
  ];

  it.effect("follows the turn Hermes still runs instead of prompting it to continue", () =>
    Effect.gen(function* () {
      // start (busy), held-frame settle polls (busy), then idle
      const fake = yield* setup({
        followWorkState: true,
        restartRecovery: true,
        admissions: [BUSY, BUSY, IDLE],
      });
      yield* fake.handle.runtime.start();
      yield* fake.emit(turnText("still sleeping"));
      expect(yield* takeAll(fake.delivered)).toEqual([]);

      const recoveryTurn = yield* fake.startPrompt();
      yield* TestClock.adjust("1 second");
      expect(yield* takeAll(fake.delivered)).toEqual([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "" } },
        turnText("still sleeping"),
      ]);
      expect(fake.handle.ownPromptOpen()).toBe(false);
      const refused = yield* fake.handle.runtime.cancel.pipe(Effect.flip);
      expect(refused).toMatchObject({ code: HERMES_STOP_UNCONFIRMED_CODE });

      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(recoveryTurn)).stopReason).toBe("end_turn");
      expect(yield* takeAll(fake.delivered)).toEqual([
        { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      ]);
      expect(fake.prompts()).toBe(0);
    }),
  );

  it.effect("prompts the recovery turn as usual once Hermes has finished", () =>
    Effect.gen(function* () {
      const fake = yield* setup({ followWorkState: true, restartRecovery: true });
      yield* fake.handle.runtime.start();
      yield* fake.startPrompt();
      yield* Queue.take(fake.promptStarted);
      expect(fake.prompts()).toBe(1);
    }),
  );

  it.effect("hands Hermes T3's tools once the turn it reattached to ends", () =>
    Effect.gen(function* () {
      // start (busy), first settle poll (busy), second (idle), swap check (idle)
      const fake = yield* setup({
        followWorkState: true,
        deferredMcpServers: T3_TOOLS,
        admissions: [BUSY, BUSY, IDLE],
        replay: [turnText("history")],
      });
      yield* fake.handle.runtime.start();
      expect(fake.loads).toEqual([]);
      yield* TestClock.adjust("1 second");
      expect(fake.loads).toEqual([]);
      yield* TestClock.adjust("1 second");
      expect(fake.loads).toEqual([{ mcpServers: T3_TOOLS }]);
      // The reload's replay is history, not a run.
      expect(yield* takeAll(fake.delivered)).toEqual([
        { sessionUpdate: "state_update", state: "running" },
        { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      ]);

      yield* fake.startPrompt();
      yield* Queue.take(fake.promptStarted);
      expect(fake.loads).toHaveLength(1);
    }),
  );
});
