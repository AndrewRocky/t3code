import { it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";
import * as Effect from "effect/Effect";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { describe, expect } from "vite-plus/test";

import { HERMES_EDIT_APPROVAL_POLICY_CONFIG_ID } from "./acpSupport.ts";
import {
  type HermesDispatchedDelegation,
  type HermesRuntimeOptions,
  makeHermesRuntime,
} from "./runtime.ts";
import { HERMES_CHILD_META_KEY } from "./subagents.ts";

type Notification = EffectAcpSchema.SessionNotification;
type Handler = (notification: Notification) => Effect.Effect<void, EffectAcpErrors.AcpError>;

const SESSION = "hermes-session-1";

interface FakeBaseOptions {
  /** Frames Hermes sends while answering a hidden prompt, by prompt text. */
  readonly controlReplies?: (text: string) => ReadonlyArray<Notification["update"]>;
  readonly configOptions?: ReadonlyArray<{ readonly id: string }>;
  readonly setModeError?: EffectAcpErrors.AcpError;
  readonly onPrompt?: () => void;
}

/** The shared runtime as the decorator uses it: one handler, prompts, requests and modes. */
function makeFakeBase(fake: FakeBaseOptions = {}) {
  let baseHandler: Handler | undefined;
  const prompts: Array<ReadonlyArray<EffectAcpSchema.ContentBlock>> = [];
  const controlPrompts: Array<string> = [];
  const modes: Array<string> = [];
  const emit = (update: Notification["update"]) =>
    baseHandler === undefined ? Effect.void : baseHandler({ sessionId: SESSION, update });

  const runtime = {
    handleSessionUpdate: (handler: Handler) =>
      Effect.sync(() => {
        if (baseHandler !== undefined) throw new Error("registered twice with the base runtime");
        baseHandler = handler;
      }),
    start: () =>
      Effect.succeed({
        sessionId: SESSION,
        initializeResult: {},
        sessionSetupResult: {},
        modelConfigId: undefined,
      }),
    loadSession: () =>
      Effect.succeed({
        sessionId: SESSION,
        initializeResult: {},
        sessionSetupResult: {},
        modelConfigId: undefined,
      }),
    prompt: (payload: { readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock> }) =>
      Effect.sync(() => {
        fake.onPrompt?.();
        prompts.push(payload.prompt);
        return { stopReason: "end_turn" };
      }),
    request: (_method: string, payload: { readonly prompt: ReadonlyArray<{ text: string }> }) =>
      Effect.gen(function* () {
        const text = payload.prompt[0]?.text ?? "";
        controlPrompts.push(text);
        for (const update of fake.controlReplies?.(text) ?? []) yield* emit(update);
        return { stopReason: "end_turn" };
      }),
    getConfigOptions: Effect.succeed(fake.configOptions ?? []),
    setMode: (modeId: string) =>
      fake.setModeError === undefined
        ? Effect.sync(() => {
            modes.push(modeId);
            return {};
          })
        : Effect.fail(fake.setModeError),
  } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

  return { runtime, emit, prompts, controlPrompts, modes };
}

const commandReply = (text: string): Notification["update"] => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

const turnText = (text: string): Notification["update"] => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  messageId: "msg-1",
});

const options = (overrides: Partial<HermesRuntimeOptions> = {}): HermesRuntimeOptions => ({
  threadId: "thread-1",
  cwd: "/repo",
  launchYolo: false,
  skillNames: () => Effect.succeed(["pdf"]),
  mediaTagOptions: { homeDir: "/home/me", isFile: () => false },
  ...overrides,
});

/** Builds the decorator, registers an adapter handler and starts the session. */
const setup = Effect.fn(function* (
  fake: FakeBaseOptions = {},
  overrides: Partial<HermesRuntimeOptions> = {},
) {
  const base = makeFakeBase(fake);
  const handle = yield* makeHermesRuntime(base.runtime, options(overrides));
  const delivered: Array<Notification> = [];
  yield* handle.runtime.handleSessionUpdate((notification) =>
    Effect.sync(() => void delivered.push(notification)),
  );
  yield* handle.runtime.start();
  const shownText = () =>
    delivered.flatMap(({ update }) =>
      update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
        ? [update.content.text]
        : [],
    );
  return { base, handle, delivered, shownText };
});

describe("makeHermesRuntime", () => {
  it.effect("names an invoked skill after the user's text, and leaves commands alone", () =>
    Effect.gen(function* () {
      const { base, handle } = yield* setup();
      yield* handle.runtime.prompt({ prompt: [{ type: "text", text: "$pdf summarise" }] });
      yield* handle.runtime.prompt({ prompt: [{ type: "text", text: "/compact $pdf" }] });
      const [first, second] = base.prompts.map((prompt) => prompt[0]);
      expect(first?.type === "text" && first.text).toContain('skill_view("pdf")');
      expect(second).toEqual({ type: "text", text: "/compact $pdf" });
    }),
  );

  it.effect("does not look up skills for a prompt without a token", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const { handle } = yield* setup(
        {},
        { skillNames: () => Effect.sync(() => ((lookups += 1), ["pdf"])) },
      );
      yield* handle.runtime.prompt({ prompt: [{ type: "text", text: "run the tests" }] });
      expect(lookups).toBe(0);
    }),
  );

  it.effect(
    "renders a MEDIA tag split across chunks and releases held text before a tool call",
    () =>
      Effect.gen(function* () {
        const { base, delivered, shownText } = yield* setup();
        yield* base.emit(turnText("Here it is:\nMED"));
        yield* base.emit(turnText("IA:/tmp/shot.png\n"));
        yield* base.emit(turnText("MEDIA:/tmp/late.png"));
        yield* base.emit({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file" });
        expect(shownText().join("")).toBe(
          "Here it is:\n![shot.png](/tmp/shot.png)\n![late.png](/tmp/late.png)",
        );
        expect(delivered.at(-1)?.update.sessionUpdate).toBe("tool_call");
      }),
  );

  it.effect("releases held text when the prompt ends", () =>
    Effect.gen(function* () {
      const { base, handle, shownText } = yield* setup();
      yield* base.emit(turnText("see MEDIA:/tmp/a.png"));
      expect(shownText().join("")).not.toContain("a.png");
      yield* handle.runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });
      expect(shownText().join("")).toBe("see ![a.png](/tmp/a.png)");
    }),
  );

  it.effect("returns a hidden prompt's reply without showing it", () =>
    Effect.gen(function* () {
      const { handle, shownText } = yield* setup({
        controlReplies: (text) =>
          text === "/steer also add tests"
            ? [turnText("Working on it. "), commandReply("⏩ Steer queued for the active turn: …")]
            : [],
      });
      const reply = yield* handle.controlPrompt("/steer also add tests");
      expect(reply).toBe("⏩ Steer queued for the active turn: …");
      expect(shownText()).toEqual(["Working on it. "]);
    }),
  );

  it.effect("drops a steer acknowledgement that arrives after its prompt returned", () =>
    Effect.gen(function* () {
      const { base, shownText } = yield* setup();
      yield* base.emit(commandReply("⏩ Steer queued for the active turn: also add tests"));
      yield* base.emit(commandReply("Context compressed."));
      expect(shownText()).toEqual(["Context compressed."]);
    }),
  );

  it.effect("refuses a hidden prompt before a session exists", () =>
    Effect.gen(function* () {
      const base = makeFakeBase();
      const handle = yield* makeHermesRuntime(base.runtime, options());
      const error = yield* handle.controlPrompt("/yolo").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      expect(base.controlPrompts).toEqual([]);
    }),
  );

  it.effect("switches YOLO with the mode and leaves it when it already matches", () =>
    Effect.gen(function* () {
      let yolo = false;
      const { base, handle } = yield* setup({
        controlReplies: (text) => {
          if (text !== "/yolo") return [];
          yolo = !yolo;
          return [commandReply(yolo ? "⚡ YOLO mode enabled" : "⚠️ YOLO mode disabled")];
        },
      });
      yield* handle.runtime.setMode("accept_edits");
      expect(base.controlPrompts).toEqual([]);
      yield* handle.runtime.setMode("dont_ask");
      yield* handle.runtime.setMode("dont_ask");
      expect(base.controlPrompts).toEqual(["/yolo"]);
      yield* handle.runtime.setMode("default");
      expect(base.controlPrompts).toEqual(["/yolo", "/yolo"]);
      expect(base.modes).toEqual(["accept_edits", "dont_ask", "dont_ask", "default"]);
    }),
  );

  it.effect("learns YOLO from the reply when a loaded session's state is unknown", () =>
    Effect.gen(function* () {
      let yolo = true;
      const base = makeFakeBase({
        controlReplies: (text) => {
          if (text !== "/yolo") return [];
          yolo = !yolo;
          return [commandReply(yolo ? "⚡ YOLO activado" : "⚠️ YOLO desactivado")];
        },
      });
      const handle = yield* makeHermesRuntime(base.runtime, options());
      yield* handle.runtime.handleSessionUpdate(() => Effect.void);
      yield* handle.runtime.loadSession(SESSION, { cwd: "/repo", mcpServers: [] } as never);
      yield* handle.runtime.setMode("dont_ask");
      expect(base.controlPrompts).toEqual(["/yolo", "/yolo"]);
      expect(yolo).toBe(true);
    }),
  );

  it.effect("sends v0.23 policy values when Hermes publishes the edit policy option", () =>
    Effect.gen(function* () {
      const { base, handle } = yield* setup({
        configOptions: [{ id: HERMES_EDIT_APPROVAL_POLICY_CONFIG_ID }],
        controlReplies: () => [commandReply("⚡ YOLO mode enabled")],
      });
      yield* handle.runtime.setMode("accept_edits");
      yield* handle.runtime.setMode("dont_ask");
      expect(base.modes).toEqual(["workspace_session", "session"]);
    }),
  );

  it.effect("leaves the mode to the next turn when Hermes is busy", () =>
    Effect.gen(function* () {
      const { base, handle } = yield* setup({
        setModeError: new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "session is busy",
        }),
      });
      const result = yield* handle.runtime.setMode("dont_ask");
      expect(result).toEqual({});
      expect(base.controlPrompts).toEqual([]);
    }),
  );

  it.effect("adds a row per started child after the delegation handle", () =>
    Effect.gen(function* () {
      const dispatched: Array<HermesDispatchedDelegation> = [];
      const { base, delivered } = yield* setup(
        {},
        { onDelegationDispatched: (entry) => Effect.sync(() => void dispatched.push(entry)) },
      );
      const handle = {
        status: "dispatched",
        mode: "background",
        count: 2,
        delegation_id: "deleg_1",
        goals: ["map the parser", "unreachable", "write tests"],
        subagent_ids: ["sa-a", "sa-c"],
        refused: [{ task_index: 1, error: "depth limit" }],
      };
      yield* base.emit({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: JSON.stringify(handle) } }],
      });
      expect(delivered.map(({ update }) => update.sessionUpdate)).toEqual([
        "tool_call_update",
        "tool_call",
        "tool_call",
      ]);
      const children = delivered
        .slice(1)
        .map(({ update }) =>
          update.sessionUpdate === "tool_call"
            ? { title: update.title, meta: update._meta?.[HERMES_CHILD_META_KEY] }
            : undefined,
        );
      expect(children).toEqual([
        {
          title: "map the parser",
          meta: {
            nativeTaskId: "sa-a",
            delegationId: "deleg_1",
            taskIndex: 0,
            goal: "map the parser",
          },
        },
        {
          title: "write tests",
          meta: {
            nativeTaskId: "sa-c",
            delegationId: "deleg_1",
            taskIndex: 2,
            goal: "write tests",
          },
        },
      ]);
      expect(dispatched.map((entry) => entry.toolCallId)).toEqual(["call-1"]);
    }),
  );

  it.effect("counts its own prompt as open only while Hermes is answering it", () =>
    Effect.gen(function* () {
      const openDuring: Array<boolean> = [];
      const { handle } = yield* setup({ onPrompt: () => openDuring.push(handle.ownPromptOpen()) });
      expect(handle.ownPromptOpen()).toBe(false);
      yield* handle.runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });
      expect(openDuring).toEqual([true]);
      expect(handle.ownPromptOpen()).toBe(false);
    }),
  );
});
