import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
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
import { type HermesAdmissionReader, hermesSessionBusy } from "./workState.ts";

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

/** Each `session/cancel` is a stop attempt inside the viewer; repeating one is harmless. */
const STOP_NUDGE_INTERVAL = "3 seconds";
const DEFAULT_STOP_BOUND: Duration.Input = "45 seconds";
/** The shared adapter gives `closeSession` 10 seconds before it reports the Stop unconfirmed. */
const CLOSE_STOP_BOUND: Duration.Input = "9 seconds";

const FOREIGN_POLL_INTERVAL = "1 second";
/** With no readable store, work T3 did not start counts as done once Hermes goes quiet. */
const FOREIGN_QUIET_MS = 5_000;

/**
 * A load carries T3's freshly issued MCP credential, which Hermes can rebind
 * only while the session is idle. Failing the load would make T3 open a second
 * Hermes session in the same worktree next to the running one.
 */
const RESUME_CONFLICT_PATTERN = /session_busy|acp_mcp_policy_conflict/u;
const RESUME_WAIT_POLL = "2 seconds";
const RESUME_WAIT_BOUND = "2 minutes";

/** T3's own code for a Stop Hermes has not confirmed; Hermes never sends it. */
export const HERMES_STOP_UNCONFIRMED_CODE = -32099;

/**
 * Which Hermes work this viewer can see: `own` is a `session/prompt` it has
 * open, the only turn `session/cancel` reaches; `foreign` is work the daemon
 * runs for the session without one (another Hermes app, a delegation result,
 * a turn from before a restart).
 */
export type HermesWorkState = "own" | "foreign" | "idle" | "unknown";

export interface HermesDispatchedDelegation {
  readonly threadId: string | undefined;
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
  readonly readAdmissions?: HermesAdmissionReader;
  /**
   * Reports Hermes' work as ACP v2 work state, so the shared adapter settles
   * turns when Hermes is idle and shows work T3 did not start as a run.
   */
  readonly followWorkState?: boolean;
  readonly stopBound?: Duration.Input;
}

/** What the session decorator and the package services reach a live runtime through. */
export interface HermesRuntimeHandle {
  readonly threadId: string | undefined;
  readonly runtime: Runtime;
  readonly sessionId: () => string | undefined;
  /** True while this viewer has a `session/prompt` open, the only turn `session/cancel` reaches. */
  readonly ownPromptOpen: () => boolean;
  readonly workState: () => Effect.Effect<HermesWorkState>;
  /** Hermes' queued admissions, which a just-sent prompt may be one of. */
  readonly queuedAdmissions: () => Effect.Effect<number | undefined>;
  /** Stops this viewer's own turn; false when Hermes did not confirm within the bound. */
  readonly stopOwnTurn: (bound: Duration.Input) => Effect.Effect<boolean>;
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

/** Frames that mean Hermes is working, as opposed to notices and session metadata. */
function isWorkUpdate(update: EffectAcpSchema.SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.messageId != null;
    case "agent_thought_chunk":
    case "user_message_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
      return true;
    default:
      return false;
  }
}

function isResumeConflict(error: EffectAcpErrors.AcpError): boolean {
  if (error._tag !== "AcpRequestError") return false;
  let data = "";
  try {
    data = JSON.stringify(error.data) ?? "";
  } catch {
    data = "";
  }
  return RESUME_CONFLICT_PATTERN.test(`${error.errorMessage} ${data}`);
}

const stopUnconfirmed = () =>
  new EffectAcpErrors.AcpRequestError({
    code: HERMES_STOP_UNCONFIRMED_CODE,
    errorMessage: "Hermes has not confirmed the stop and is still working.",
  });

const foreignStopRefused = () =>
  new EffectAcpErrors.AcpRequestError({
    code: HERMES_STOP_UNCONFIRMED_CODE,
    errorMessage:
      "Hermes is finishing a turn this T3 Code session did not start, which T3 Code cannot stop on this Hermes version.",
  });

export const makeHermesRuntime = Effect.fn("HermesRuntime.make")(function* (
  base: Runtime,
  options: HermesRuntimeOptions,
) {
  const lock = yield* Semaphore.make(1);
  const followWorkState = options.followWorkState === true;
  let adapterHandler: SessionUpdateHandler | undefined;
  let sessionId: string | undefined;
  let openPrompts = 0;
  let activePrompt: Deferred.Deferred<void> | undefined;
  /** The own prompt a Stop is cancelling, until Hermes returns it. */
  let stoppingPrompt: Deferred.Deferred<void> | undefined;
  let yolo: boolean | undefined;
  /** Session setup replays the transcript; those frames are history, not work. */
  let loading = 0;
  let foreignActive = false;
  let lastWorkFrameAt = 0;
  const foreignWake = yield* Queue.dropping<void>(1);
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

  const readAdmissions = (session: string) =>
    options.readAdmissions === undefined
      ? Effect.succeed(undefined)
      : options.readAdmissions(session);

  const deliverWorkState = (
    session: string,
    state:
      | { readonly state: "running" }
      | { readonly state: "idle"; readonly stopReason: EffectAcpSchema.StopReason },
  ) => deliver({ sessionId: session, update: { sessionUpdate: "state_update", ...state } });

  const beginForeignWork = Effect.fnUntraced(function* (session: string) {
    foreignActive = true;
    lastWorkFrameAt = yield* Clock.currentTimeMillis;
    yield* deliverWorkState(session, { state: "running" });
    yield* Queue.offer(foreignWake, undefined);
  });

  /** Called under the lock; work Hermes queued behind T3's turn becomes the adapter's next run. */
  const followForeignWorkIfBusy = Effect.fnUntraced(function* (session: string) {
    if (!followWorkState || foreignActive || openPrompts > 0) return;
    const admissions = yield* readAdmissions(session);
    if (admissions !== undefined && hermesSessionBusy(admissions)) {
      yield* beginForeignWork(session);
    }
  });

  const settleForeignWorkIfIdle = Effect.fnUntraced(function* () {
    const session = sessionId;
    if (!foreignActive || openPrompts > 0 || session === undefined) return;
    const admissions = yield* readAdmissions(session);
    const now = yield* Clock.currentTimeMillis;
    const idle =
      admissions === undefined
        ? now - lastWorkFrameAt >= FOREIGN_QUIET_MS
        : !hermesSessionBusy(admissions);
    if (!idle) return;
    foreignActive = false;
    yield* flushMedia(session);
    yield* deliverWorkState(session, { state: "idle", stopReason: "end_turn" });
  });

  const followForeignWork: Effect.Effect<void> = Effect.sleep(FOREIGN_POLL_INTERVAL).pipe(
    Effect.andThen(
      lock
        .withPermit(settleForeignWorkIfIdle())
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not settle Hermes work T3 did not start.", { cause }),
          ),
        ),
    ),
    Effect.andThen(Effect.suspend(() => (foreignActive ? followForeignWork : Effect.void))),
  );

  if (followWorkState) {
    yield* Queue.take(foreignWake).pipe(
      Effect.andThen(followForeignWork),
      Effect.forever,
      Effect.forkScoped,
    );
  }

  /**
   * Hermes reports the tool a Stop cut short as failed. Left open, the adapter
   * shows it interrupted when the cancelled prompt returns.
   */
  const stopCutTool = (notification: SessionNotification): SessionNotification =>
    notification.update.sessionUpdate === "tool_call_update" &&
    notification.update.status === "failed" &&
    stoppingPrompt !== undefined &&
    stoppingPrompt === activePrompt
      ? { ...notification, update: { ...notification.update, status: "in_progress" } }
      : notification;

  const process = Effect.fnUntraced(function* (received: SessionNotification) {
    const notification = stopCutTool(received);
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
    }
    if (isWorkUpdate(update)) {
      // Under work state a frame outside a turn starts a run, so a replayed
      // transcript must not reach the adapter at all.
      if (loading > 0 && followWorkState) return;
      if (followWorkState && openPrompts === 0 && notification.sessionId === sessionId) {
        if (!foreignActive) yield* beginForeignWork(notification.sessionId);
        lastWorkFrameAt = yield* Clock.currentTimeMillis;
      }
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = textOf(update.content);
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
      loading === 0 &&
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
            threadId: options.threadId,
            sessionId: notification.sessionId,
            toolCallId: update.toolCallId,
            dispatch,
          }) ?? Effect.void
        );
      }
    }
  });

  /**
   * The adapter follows work state only for ACP v2 agents. Hermes speaks v1
   * on the wire, and nothing else reads the version from the start result.
   */
  const asStarted = (result: AcpSessionRuntime.AcpSessionRuntimeStartResult) =>
    followWorkState
      ? { ...result, initializeResult: { ...result.initializeResult, protocolVersion: 2 } }
      : result;

  /** Setup replays the transcript; afterwards, Hermes may still be working from before. */
  const settingUp = (
    setup: Effect.Effect<AcpSessionRuntime.AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>,
    knownYolo?: boolean,
  ) =>
    Effect.sync(() => {
      loading += 1;
    }).pipe(
      Effect.andThen(setup),
      Effect.ensuring(
        Effect.sync(() => {
          loading -= 1;
        }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          sessionId = result.sessionId;
          yolo = knownYolo;
        }),
      ),
      Effect.tap((result) =>
        lock
          .withPermit(followForeignWorkIfBusy(result.sessionId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not check whether Hermes is still working.", { cause }),
            ),
          ),
      ),
      Effect.map(asStarted),
    );

  const afterHermesIdles = (
    id: string,
    load: Effect.Effect<AcpSessionRuntime.AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>,
  ) =>
    load.pipe(
      Effect.catchIf(isResumeConflict, (error) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Hermes is finishing earlier work; reattaching once it is idle.");
          const idle = yield* Effect.sleep(RESUME_WAIT_POLL).pipe(
            Effect.andThen(readAdmissions(id)),
            Effect.repeat({
              until: (admissions) => admissions === undefined || !hermesSessionBusy(admissions),
            }),
            Effect.timeoutOption(RESUME_WAIT_BOUND),
          );
          return Option.isNone(idle) ? yield* error : yield* load;
        }),
      ),
    );

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

  /**
   * Hermes answers `session/cancel` by stopping this viewer's admission, and
   * confirms by returning the prompt. A Stop is reported only once it has: the
   * adapter finalizes the turn as interrupted soon after `cancel` returns.
   */
  const stopOwnTurn = Effect.fn("HermesRuntime.stopOwnTurn")(function* (bound: Duration.Input) {
    const done = activePrompt;
    if (done === undefined) return true;
    stoppingPrompt = done;
    const nudge = base.cancel.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hermes refused a session/cancel.", { cause }),
      ),
      Effect.andThen(Deferred.await(done).pipe(Effect.timeoutOption(STOP_NUDGE_INTERVAL))),
    );
    const confirmed = yield* nudge.pipe(
      Effect.repeat({ until: Option.isSome }),
      Effect.timeoutOption(bound),
    );
    return Option.isSome(confirmed);
  });

  /** Under the lock, so no frame lands between the prompt's end and its work-state idle. */
  const finishPrompt = Effect.fnUntraced(function* (
    done: Deferred.Deferred<void>,
    exit: Exit.Exit<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>,
  ) {
    openPrompts -= 1;
    if (activePrompt === done) activePrompt = undefined;
    if (stoppingPrompt === done) stoppingPrompt = undefined;
    yield* Deferred.succeed(done, undefined);
    const session = sessionId;
    if (session === undefined) return;
    yield* flushMedia(session);
    // A failed prompt is finalized by the adapter itself.
    if (!followWorkState || Exit.isFailure(exit) || openPrompts > 0) return;
    yield* deliverWorkState(session, { state: "idle", stopReason: exit.value.stopReason });
    yield* followForeignWorkIfBusy(session);
  });

  const workState = Effect.fn("HermesRuntime.workState")(function* () {
    if (openPrompts > 0) return "own" as const;
    if (foreignActive) return "foreign" as const;
    const session = sessionId;
    if (session === undefined) return "idle" as const;
    const admissions = yield* readAdmissions(session);
    if (admissions === undefined) return "unknown" as const;
    return hermesSessionBusy(admissions) ? ("foreign" as const) : ("idle" as const);
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
    start: () => settingUp(base.start(), options.launchYolo),
    loadSession: (id, activation) =>
      settingUp(afterHermesIdles(id, base.loadSession(id, activation))),
    resumeSession: (id, activation) =>
      settingUp(afterHermesIdles(id, base.resumeSession(id, activation))),
    forkSession: (id, activation) => settingUp(base.forkSession(id, activation)),
    prompt: Effect.fn("HermesRuntime.prompt")(function* (payload, promptOptions) {
      const blocks = payload.prompt;
      const mentionsSkill = blocks.some(
        (block) => block.type === "text" && block.text.includes("$"),
      );
      const skillNames = mentionsSkill ? yield* options.skillNames(options.cwd) : [];
      const prompt = promptWithSkillDirective(blocks, skillNames);
      const done = yield* Deferred.make<void>();
      yield* lock.withPermit(
        Effect.gen(function* () {
          openPrompts += 1;
          activePrompt = done;
          // The turn covers whatever Hermes still runs ahead of this prompt.
          foreignActive = false;
          if (followWorkState && sessionId !== undefined) {
            // A user echo accepts the turn's work; Hermes sends none for a live prompt.
            yield* deliver({
              sessionId: sessionId,
              update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "" } },
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not mark the Hermes turn accepted.", { cause }),
              ),
            );
          }
        }),
      );
      return yield* base
        .prompt({ ...payload, prompt: [...prompt] }, promptOptions)
        .pipe(
          Effect.onExit((exit) =>
            lock
              .withPermit(finishPrompt(done, exit))
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not finish the Hermes turn cleanly.", { cause }),
                ),
              ),
          ),
        );
    }),
    setMode,
    cancel: Effect.gen(function* () {
      if (activePrompt === undefined) return yield* base.cancel;
      if (!(yield* stopOwnTurn(options.stopBound ?? DEFAULT_STOP_BOUND))) {
        return yield* stopUnconfirmed();
      }
    }),
    // Hermes has no `session/close`; a Stop that closes the session stops the turn instead.
    closeSession: Effect.fn("HermesRuntime.closeSession")(function* () {
      if (activePrompt !== undefined) {
        if (!(yield* stopOwnTurn(CLOSE_STOP_BOUND))) return yield* stopUnconfirmed();
        return {};
      }
      if ((yield* workState()) === "foreign") return yield* foreignStopRefused();
      return {};
    }),
  };

  const handle: HermesRuntimeHandle = {
    threadId: options.threadId,
    runtime,
    sessionId: () => sessionId,
    ownPromptOpen: () => openPrompts > 0,
    workState,
    queuedAdmissions: () =>
      sessionId === undefined
        ? Effect.succeed(undefined)
        : readAdmissions(sessionId).pipe(Effect.map((admissions) => admissions?.queued)),
    stopOwnTurn,
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
