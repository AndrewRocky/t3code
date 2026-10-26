import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";

import {
  HERMES_EDIT_APPROVAL_POLICY_CONFIG_ID,
  hermesEditPolicyForMode,
  hermesYoloForMode,
} from "./acpSupport.ts";
import { type HermesMediaTagOptions, makeHermesMediaTagStream } from "./mediaTags.ts";
import { applyHermesSkillDirective } from "./skillDirective.ts";
import {
  HERMES_CHILD_META_KEY,
  type HermesDelegationDispatch,
  hermesChildLabel,
  hermesChildNativeTaskId,
  hermesChildToolCallId,
  hermesDelegationIdForChild,
  parseHermesDelegationHandle,
} from "./subagents.ts";

// The runtime decorator translates Hermes' gateway dialect into standard ACP
// before the shared adapter sees it, the way Grok's
// `makeXAiPromptCompletionRuntime` does. It relies on the adapter registering
// one session-update handler and sending turns through `prompt`; the tests in
// `runtime.test.ts` pin that.

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type SessionNotification = EffectAcpSchema.SessionNotification;
type SessionUpdateHandler = (
  notification: SessionNotification,
) => Effect.Effect<void, EffectAcpErrors.AcpError>;

/** Command replies and steer acks come without a `messageId`; turn text always has one. */
const STEER_ACK_PREFIX = "⏩ Steer queued for the active turn";

/** `/yolo` replies are localized, but every locale keeps the leading emoji. */
const YOLO_ON_PREFIX = "⚡";
const YOLO_OFF_PREFIX = "⚠";

/** JSON-RPC internal error: Hermes refuses a mode change while the session is busy. */
const HERMES_BUSY_ERROR_CODE = -32603;

const CONTROL_PROMPT_TIMEOUT = "15 seconds";

export interface HermesDispatchedDelegation {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly dispatch: HermesDelegationDispatch;
}

export interface HermesRuntimeOptions {
  readonly threadId: string | undefined;
  readonly cwd: string;
  /**
   * YOLO in the launch environment, which a `session/new` adopts; undefined
   * when `start` resumes a saved session, whose frozen value is unknown.
   */
  readonly launchYolo: boolean | undefined;
  readonly skillNames: (cwd: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly mediaTagOptions: HermesMediaTagOptions;
  readonly onDelegationDispatched?: (delegation: HermesDispatchedDelegation) => Effect.Effect<void>;
}

/** What the session decorator and the package services reach a live runtime through. */
export interface HermesRuntimeHandle {
  readonly threadId: string | undefined;
  readonly runtime: Runtime;
  readonly sessionId: () => string | undefined;
  /** True while this viewer has a `session/prompt` open, the only turn `session/cancel` reaches. */
  readonly ownPromptOpen: () => boolean;
  /** Feeds a frame to the adapter as if Hermes had sent it. */
  readonly inject: (notification: SessionNotification) => Effect.Effect<void>;
  /** Sends a hidden prompt and returns the reply text Hermes sent for it. */
  readonly controlPrompt: (text: string) => Effect.Effect<string, EffectAcpErrors.AcpError>;
  /** Filled in when the shared adapter registers its extension callbacks for this runtime. */
  readonly extensions: {
    finishSubagent?: AcpAdapterV2ExtensionContext["finishSubagent"];
  };
}

/** Live runtimes by T3 thread id; the adapter replaces a runtime on respawn and rollback. */
export class HermesRuntimeRegistry {
  readonly #byThread = new Map<string, HermesRuntimeHandle>();
  readonly #byRuntime = new WeakMap<Runtime, HermesRuntimeHandle>();

  register(handle: HermesRuntimeHandle): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#byRuntime.set(handle.runtime, handle);
      if (handle.threadId !== undefined) this.#byThread.set(handle.threadId, handle);
    });
  }

  attachExtensions(
    runtime: Runtime,
    extensions: Pick<AcpAdapterV2ExtensionContext, "finishSubagent">,
  ): void {
    const handle = this.#byRuntime.get(runtime);
    if (handle !== undefined) handle.extensions.finishSubagent = extensions.finishSubagent;
  }

  unregister(handle: HermesRuntimeHandle): Effect.Effect<void> {
    return Effect.sync(() => {
      if (handle.threadId !== undefined && this.#byThread.get(handle.threadId) === handle) {
        this.#byThread.delete(handle.threadId);
      }
    });
  }

  get(threadId: string): HermesRuntimeHandle | undefined {
    return this.#byThread.get(threadId);
  }

  all(): ReadonlyArray<HermesRuntimeHandle> {
    return [...this.#byThread.values()];
  }
}

function textOf(content: EffectAcpSchema.ContentBlock | undefined): string | undefined {
  return content?.type === "text" ? content.text : undefined;
}

function toolCallText(update: EffectAcpSchema.SessionUpdate): string | undefined {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return undefined;
  }
  const texts = (update.content ?? []).flatMap((entry) =>
    entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : [],
  );
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function isBusyRefusal(error: EffectAcpErrors.AcpError): boolean {
  return error._tag === "AcpRequestError" && error.code === HERMES_BUSY_ERROR_CODE;
}

function childToolCalls(
  sessionId: string,
  dispatch: HermesDelegationDispatch,
): ReadonlyArray<SessionNotification> {
  return dispatch.children.map((child) => {
    const nativeTaskId = hermesChildNativeTaskId(dispatch, child);
    const goal = hermesChildLabel(child);
    return {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: hermesChildToolCallId(nativeTaskId),
        title: goal,
        kind: "other",
        status: "in_progress",
        _meta: {
          [HERMES_CHILD_META_KEY]: {
            nativeTaskId,
            delegationId: hermesDelegationIdForChild(dispatch, child) ?? null,
            taskIndex: child.taskIndex,
            goal,
          },
        },
      },
    } satisfies SessionNotification;
  });
}

/** The first text block carries the user's message; the directive follows it. */
function promptWithSkillDirective(
  prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  skillNames: ReadonlyArray<string>,
): ReadonlyArray<EffectAcpSchema.ContentBlock> {
  const index = prompt.findIndex((block) => block.type === "text");
  const block = prompt[index];
  if (block?.type !== "text" || block.text.trimStart().startsWith("/")) return prompt;
  const next = applyHermesSkillDirective(block.text, skillNames);
  if (next === block.text) return prompt;
  return prompt.map((entry, position) => (position === index ? { ...block, text: next } : entry));
}

export const makeHermesRuntime = Effect.fn("HermesRuntime.make")(function* (
  base: Runtime,
  options: HermesRuntimeOptions,
) {
  const lock = yield* Semaphore.make(1);
  let adapterHandler: SessionUpdateHandler | undefined;
  let sessionId: string | undefined;
  let openPrompts = 0;
  let yolo: boolean | undefined;
  const controlReplies = new Map<string, Array<string>>();
  const mediaStreams = new Map<
    string,
    { readonly stream: ReturnType<typeof makeHermesMediaTagStream>; messageId: string | null }
  >();

  const deliver = (notification: SessionNotification) =>
    adapterHandler === undefined ? Effect.void : adapterHandler(notification);

  const mediaStream = (session: string) => {
    let entry = mediaStreams.get(session);
    if (entry === undefined) {
      entry = { stream: makeHermesMediaTagStream(options.mediaTagOptions), messageId: null };
      mediaStreams.set(session, entry);
    }
    return entry;
  };

  /** Held-back `MEDIA:` text is released before anything that is not reply text. */
  const flushMedia = (session: string) =>
    Effect.suspend(() => {
      const entry = mediaStreams.get(session);
      const text = entry?.stream.flush() ?? "";
      if (entry === undefined || text.length === 0) return Effect.void;
      return deliver({
        sessionId: session,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          ...(entry.messageId === null ? {} : { messageId: entry.messageId }),
        },
      });
    });

  const process = Effect.fnUntraced(function* (notification: SessionNotification) {
    const update = notification.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = textOf(update.content);
      if (update.messageId == null && text !== undefined) {
        const captured = controlReplies.get(notification.sessionId);
        if (captured !== undefined) {
          captured.push(text);
          return;
        }
        if (text.startsWith(STEER_ACK_PREFIX)) return;
      }
      if (text !== undefined) {
        const entry = mediaStream(notification.sessionId);
        entry.messageId = update.messageId ?? entry.messageId;
        const shown = entry.stream.push(text);
        if (shown.length === 0) return;
        yield* deliver({
          ...notification,
          update: { ...update, content: { type: "text", text: shown } },
        });
        return;
      }
    }
    yield* flushMedia(notification.sessionId);
    yield* deliver(notification);
    if (
      update.sessionUpdate === "tool_call_update" &&
      (update.status === "completed" || update.status === "failed")
    ) {
      const dispatch = parseHermesDelegationHandle(toolCallText(update));
      if (dispatch !== undefined) {
        yield* Effect.forEach(childToolCalls(notification.sessionId, dispatch), deliver, {
          discard: true,
        });
        yield* (
          options.onDelegationDispatched?.({
            sessionId: notification.sessionId,
            toolCallId: update.toolCallId,
            dispatch,
          }) ?? Effect.void
        );
      }
    }
  });

  const remember = (result: AcpSessionRuntime.AcpSessionRuntimeStartResult, knownYolo?: boolean) =>
    Effect.sync(() => {
      sessionId = result.sessionId;
      yolo = knownYolo;
      return result;
    });

  const controlPrompt = Effect.fn("HermesRuntime.controlPrompt")(function* (text: string) {
    const session = sessionId;
    if (session === undefined) {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32600,
        errorMessage: "Hermes control prompt sent before a session started.",
      });
    }
    const captured: Array<string> = [];
    controlReplies.set(session, captured);
    yield* base
      .request("session/prompt", { sessionId: session, prompt: [{ type: "text", text }] })
      .pipe(
        Effect.timeoutOption(CONTROL_PROMPT_TIMEOUT),
        Effect.ensuring(Effect.sync(() => controlReplies.delete(session))),
      );
    return captured.join("");
  });

  /**
   * `/yolo` toggles and cannot set, so the decorator remembers the state it
   * last confirmed and toggles until the reply matches. After a respawn the
   * state is unknown and the first reply tells it.
   */
  const ensureYolo = Effect.fn("HermesRuntime.ensureYolo")(function* (desired: boolean) {
    for (let attempt = 0; attempt < 2 && yolo !== desired; attempt += 1) {
      const reply = yield* controlPrompt("/yolo");
      const confirmed = reply.trimStart().startsWith(YOLO_ON_PREFIX)
        ? true
        : reply.trimStart().startsWith(YOLO_OFF_PREFIX)
          ? false
          : undefined;
      if (confirmed === undefined) {
        yield* Effect.logWarning("Hermes did not confirm a /yolo toggle.", { reply });
        return;
      }
      yolo = confirmed;
    }
  });

  const setMode: Runtime["setMode"] = Effect.fn("HermesRuntime.setMode")(function* (modeId) {
    const configOptions = yield* base.getConfigOptions;
    const usesPolicyValues = configOptions.some(
      (option) => option.id === HERMES_EDIT_APPROVAL_POLICY_CONFIG_ID,
    );
    const result = yield* base
      .setMode(usesPolicyValues ? hermesEditPolicyForMode(modeId) : modeId)
      .pipe(
        Effect.asSome,
        Effect.catchIf(isBusyRefusal, () =>
          Effect.logInfo(
            "Hermes is busy; the mode change applies at its next idle turn start.",
          ).pipe(Effect.as(Option.none<EffectAcpSchema.SetSessionModeResponse>())),
        ),
      );
    if (Option.isSome(result)) {
      yield* ensureYolo(hermesYoloForMode(modeId));
    }
    const unchanged: EffectAcpSchema.SetSessionModeResponse = {};
    return Option.getOrElse(result, () => unchanged);
  });

  const runtime: Runtime = {
    ...base,
    // Registered with the base only once the adapter registers, so frames are
    // never forwarded to a handler that does not exist yet.
    handleSessionUpdate: (handler) =>
      Effect.suspend(() => {
        const first = adapterHandler === undefined;
        adapterHandler = handler;
        return first
          ? base.handleSessionUpdate((notification) => lock.withPermit(process(notification)))
          : Effect.void;
      }),
    start: () =>
      base.start().pipe(Effect.flatMap((result) => remember(result, options.launchYolo))),
    loadSession: (id, activation) =>
      base.loadSession(id, activation).pipe(Effect.flatMap((result) => remember(result))),
    resumeSession: (id, activation) =>
      base.resumeSession(id, activation).pipe(Effect.flatMap((result) => remember(result))),
    forkSession: (id, activation) =>
      base.forkSession(id, activation).pipe(Effect.flatMap((result) => remember(result))),
    prompt: Effect.fn("HermesRuntime.prompt")(function* (payload, promptOptions) {
      const blocks = payload.prompt;
      const mentionsSkill = blocks.some(
        (block) => block.type === "text" && block.text.includes("$"),
      );
      const skillNames = mentionsSkill ? yield* options.skillNames(options.cwd) : [];
      const prompt = promptWithSkillDirective(blocks, skillNames);
      openPrompts += 1;
      return yield* base.prompt({ ...payload, prompt: [...prompt] }, promptOptions).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            openPrompts -= 1;
            if (sessionId !== undefined) {
              yield* lock
                .withPermit(flushMedia(sessionId))
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not flush held-back Hermes media text.", { cause }),
                  ),
                );
            }
          }),
        ),
      );
    }),
    setMode,
  };

  const handle: HermesRuntimeHandle = {
    threadId: options.threadId,
    runtime,
    sessionId: () => sessionId,
    ownPromptOpen: () => openPrompts > 0,
    inject: (notification) =>
      lock.withPermit(deliver(notification)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The shared ACP adapter rejected an injected Hermes frame.", {
            cause,
          }),
        ),
      ),
    controlPrompt,
    extensions: {},
  };
  return handle;
});
