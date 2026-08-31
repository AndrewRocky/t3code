/**
 * HermesAdapter — ACP session adapter for Nous Research's Hermes Agent.
 *
 * Structurally this is the Grok adapter's shape: one ACP runtime per thread,
 * a per-thread semaphore, a `PubSub` of canonical runtime events, and a
 * liveness watchdog. Four things are genuinely different, and each is the
 * reason a shared adapter would not have worked:
 *
 * 1. **Permission mode is applied after start, not at spawn.** Hermes has no
 *    `--permission-mode` flag; it advertises ACP session modes and expects
 *    `session/set_mode`. See `applyHermesAcpSessionMode`.
 *
 * 2. **Hermes never echoes a mode change back.** It emits no
 *    `current_mode_update`, so the mode we requested is recorded optimistically
 *    — the same thing the agent does to its own in-memory state.
 *
 * 3. **Three notifications carry state the shared runtime model drops.**
 *    `usage_update`, `session_info_update`, and `available_commands_update` are
 *    read through a second, raw `session/update` handler and re-emitted as
 *    `thread.token-usage.updated` / `thread.metadata.updated`. Registering a
 *    second handler is safe: the client appends handlers rather than replacing
 *    them, so the parsed turn-content stream is untouched.
 *
 * 4. **The liveness watchdog matters more here than elsewhere.** Hermes runs
 *    prompts on a four-worker thread pool shared by every session in the
 *    process, blocks up to five seconds per `session/update` delivery, and
 *    swallows agent errors into a normal `end_turn` — so a wedged turn looks
 *    exactly like a slow one from the outside. Without the deadline a lost
 *    tool update leaves the turn spinning forever.
 *
 * What is deliberately absent: no vendor request handlers (Hermes implements
 * no `ext` methods at all, so `_`-prefixed requests would be `-32601`), no
 * plan-mode interception (`session/update` plan entries are the whole story),
 * and no `session/close` (Hermes does not implement it — teardown is scope
 * closure, which kills the child process).
 *
 * @module provider/Layers/HermesAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type HermesSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  HERMES_EXTENSION_SOURCE,
  type HermesSessionProvenance,
  parseHermesAvailableCommands,
  parseHermesSessionInfo,
  parseHermesSessionProvenance,
  parseHermesUsageUpdate,
} from "../acp/HermesAcpExtension.ts";
import {
  applyHermesAcpModelSelection,
  applyHermesAcpSessionMode,
  currentHermesModelIdFromSessionSetup,
  makeHermesAcpRuntime,
  resolveHermesAcpBaseModelId,
} from "../acp/HermesAcpSupport.ts";
import { syncHermesCommandRules } from "../Drivers/HermesCommandRules.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_RESUME_VERSION = 1 as const;
const NANOS_PER_MILLI = 1_000_000n;
/**
 * Hermes' own reasoning phase is invisible over ACP, and `session/update`
 * delivery blocks its worker for up to five seconds per event, so a healthy
 * turn can be quiet for a while. Ten minutes without any ACP progress is long
 * enough that the turn is wedged rather than thinking.
 */
const DEFAULT_HERMES_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
/**
 * A Hermes tool can legitimately run far longer than that — `terminal`,
 * `delegate_task`, and `execute_code` all wrap open-ended work — so an active
 * tool call earns a much longer deadline. It still needs one: a dropped
 * `tool_call_update` would otherwise leave the turn running forever.
 */
const DEFAULT_HERMES_ACTIVE_TOOL_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface HermesAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Override the conservative ACP turn liveness timeout in focused tests. */
  readonly turnInactivityTimeoutMs?: number;
  /** Override the longer active-tool liveness timeout in focused tests. */
  readonly activeToolInactivityTimeoutMs?: number;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface HermesTurnLivenessSignal {
  readonly turnId: TurnId;
}

interface HermesSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /**
   * Number of sendTurn prompts currently in flight or being prepared. >0 means
   * a turn is actively running, so a new sendTurn is a steer that continues it
   * — which is also how Hermes itself treats a prompt during a live turn — and
   * only the last remaining prompt settles the turn.
   */
  promptsInFlight: number;
  readonly livenessSignals: Queue.Queue<HermesTurnLivenessSignal>;
  livenessTurnId: TurnId | undefined;
  lastTurnActivityAtNanos: bigint | undefined;
  readonly activeToolCallIds: Set<string>;
  livenessUpdatesInFlight: number;
  /** Prompt RPCs that returned before their turn settlement acquired the lock. */
  promptResponsesReady: number;
  currentModelId: string | undefined;
  /** Requested mode id; Hermes never confirms it, so this is what we asked for. */
  currentModeId: string | undefined;
  /** Last provenance seen, so a repeated compaction notice is not re-emitted. */
  lastProvenanceFingerprint: string | undefined;
  lastSessionTitle: string | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: HermesSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: HermesSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, HermesSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => sessions.get(threadId)?.activeTurnId;

function parseHermesResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== HERMES_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/**
 * Hermes' permission option ids, in the order `acp_adapter/permissions.py`
 * emits them. Two of them (`allow_session` and `allow_always`) share the ACP
 * kind `allow_always`, because ACP has no session-scoped allow kind — so
 * matching on kind alone cannot tell "for this session" from "forever".
 * Matching the id first keeps T3's "Always allow this session" mapped to
 * Hermes' `session` result rather than its persistent `always`.
 */
const HERMES_OPTION_ID_BY_DECISION = {
  accept: ["allow_once"],
  // Session scope first, persistent second: `allow_session` maps to Hermes'
  // `session` result, `allow_always` to its `always`.
  acceptForSession: ["allow_session", "allow_always"],
  // The mirror image — persistent first, session second — so "always allow"
  // degrades to session scope rather than silently becoming permanent or
  // silently failing when Hermes offers only one of the two.
  acceptAlways: ["allow_always", "allow_session"],
  decline: ["deny", "deny_always"],
} as const satisfies Record<Exclude<ProviderApprovalDecision, "cancel">, ReadonlyArray<string>>;

const HERMES_OPTION_KIND_BY_DECISION = {
  accept: "allow_once",
  // ACP has no session-scoped allow kind, so both persistent decisions fall
  // back to the same kind; the id table above is what separates them.
  acceptForSession: "allow_always",
  acceptAlways: "allow_always",
  decline: "reject_once",
} as const satisfies Record<Exclude<ProviderApprovalDecision, "cancel">, string>;

/**
 * Choose the option id to send back for a decision.
 *
 * Preference order: Hermes' own id, then the ACP kind, then — for
 * `acceptForSession` only — `allow_once`. That last fallback exists because
 * Hermes' *edit* approvals deliberately offer nothing but `allow_once` and
 * `deny` (`edit_approval.py`), and approve strictly on `allow_once`. Without
 * it, "Always allow this session" on a file edit would silently deny. T3
 * remembers the operation itself, so session scope is preserved on our side.
 */
export function selectHermesPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  for (const optionId of HERMES_OPTION_ID_BY_DECISION[decision]) {
    const matched = request.options.find((entry) => entry.optionId.trim() === optionId);
    const matchedId = matched?.optionId.trim();
    if (matchedId) {
      return matchedId;
    }
  }

  const preferredKind = HERMES_OPTION_KIND_BY_DECISION[decision];
  const preferred = request.options.find((entry) => entry.kind === preferredKind);
  const preferredId = preferred?.optionId.trim();
  if (preferredId) {
    return preferredId;
  }

  if (decision === "acceptForSession" || decision === "acceptAlways") {
    const once = request.options.find((entry) => entry.kind === "allow_once");
    const onceId = once?.optionId.trim();
    if (onceId) {
      return onceId;
    }
  }
  return undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectHermesPermissionOptionId(request, "acceptForSession") ??
    selectHermesPermissionOptionId(request, "accept")
  );
}

/**
 * Build the stable key an approved operation is remembered under.
 *
 * Keyed on the operation, never on the tool-call id (which changes every call)
 * and never on a bare title (which would approve every future call of that
 * tool). A title with no input at all cannot identify an operation safely, so
 * it yields no key and is asked about each time.
 */
export function hermesApprovalKey(toolCall: {
  readonly kind?: string | null;
  readonly title?: string | null;
  readonly rawInput?: unknown;
  readonly locations?: unknown;
}): string | undefined {
  const rawInput = toolCall.rawInput;
  const command =
    isRecord(rawInput) && typeof rawInput.command === "string" ? rawInput.command : undefined;
  if (!command && !(isRecord(rawInput) && Object.keys(rawInput).length > 0)) {
    return undefined;
  }
  return stableStringify({
    kind: toolCall.kind,
    title: toolCall.title,
    command,
    input: rawInput,
    locations: toolCall.locations,
  });
}

export function hermesPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

/**
 * Fingerprint for a provenance payload, so a compaction that rotates the
 * internal session once does not emit a metadata event on every later
 * notification carrying the same lineage.
 */
export function hermesProvenanceFingerprint(
  provenance: HermesSessionProvenance | undefined,
): string | undefined {
  if (!provenance) {
    return undefined;
  }
  return `${provenance.currentHermesSessionId ?? ""}:${provenance.compressionDepth ?? 0}`;
}

export function makeHermesAdapter(
  hermesSettings: HermesSettings,
  options?: HermesAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("hermes");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, HermesSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const requestedTurnInactivityTimeoutMs = options?.turnInactivityTimeoutMs;
    const turnInactivityTimeoutMs =
      typeof requestedTurnInactivityTimeoutMs === "number" &&
      Number.isFinite(requestedTurnInactivityTimeoutMs)
        ? Math.max(1, Math.floor(requestedTurnInactivityTimeoutMs))
        : DEFAULT_HERMES_TURN_INACTIVITY_TIMEOUT_MS;
    const turnInactivityTimeoutNanos = BigInt(turnInactivityTimeoutMs) * NANOS_PER_MILLI;
    const requestedActiveToolInactivityTimeoutMs = options?.activeToolInactivityTimeoutMs;
    const activeToolInactivityTimeoutMs =
      typeof requestedActiveToolInactivityTimeoutMs === "number" &&
      Number.isFinite(requestedActiveToolInactivityTimeoutMs)
        ? Math.max(1, Math.floor(requestedActiveToolInactivityTimeoutMs))
        : DEFAULT_HERMES_ACTIVE_TOOL_INACTIVITY_TIMEOUT_MS;
    const activeToolInactivityTimeoutNanos =
      BigInt(activeToolInactivityTimeoutMs) * NANOS_PER_MILLI;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Hermes runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Hermes ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    // ── Turn liveness ────────────────────────────────────────────────

    const signalTurnLiveness = (ctx: HermesSessionContext, turnId: TurnId) =>
      Queue.offer(ctx.livenessSignals, { turnId }).pipe(Effect.asVoid);

    const beginTurnLiveness = (ctx: HermesSessionContext, turnId: TurnId) =>
      Effect.sync(() => {
        ctx.livenessTurnId = turnId;
        // No deadline until ACP has made observable progress: Hermes may sit
        // on the executor queue before it emits anything at all, and that wait
        // is not a stall.
        ctx.lastTurnActivityAtNanos = undefined;
        ctx.activeToolCallIds.clear();
      });

    const clearTurnLiveness = (ctx: HermesSessionContext) => {
      const turnId = ctx.livenessTurnId;
      ctx.livenessTurnId = undefined;
      ctx.lastTurnActivityAtNanos = undefined;
      ctx.activeToolCallIds.clear();
      ctx.livenessUpdatesInFlight = 0;
      ctx.promptResponsesReady = 0;
      return turnId === undefined ? Effect.void : signalTurnLiveness(ctx, turnId);
    };

    const recordTurnActivity = Effect.fn("HermesAdapter.recordTurnActivity")(function* (
      ctx: HermesSessionContext,
      turnId: TurnId,
      event: Extract<
        AcpSessionRuntime.AcpSessionRuntimeEvent,
        {
          _tag:
            | "AssistantItemStarted"
            | "AssistantItemCompleted"
            | "PlanUpdated"
            | "ToolCallUpdated"
            | "ContentDelta";
        }
      >,
    ) {
      if (
        ctx.livenessTurnId !== turnId ||
        (event._tag === "ContentDelta" && event.text.length === 0)
      ) {
        return;
      }
      ctx.livenessUpdatesInFlight += 1;
      try {
        const activityAtNanos = yield* Clock.monotonicTimeNanos;
        if (ctx.livenessTurnId !== turnId || ctx.interruptedTurnIds.has(turnId)) {
          return;
        }
        if (event._tag === "ToolCallUpdated") {
          if (event.toolCall.status === "completed" || event.toolCall.status === "failed") {
            ctx.activeToolCallIds.delete(event.toolCall.toolCallId);
          } else {
            // Hermes only ever sends `tool_call` (no status) and a terminal
            // `tool_call_update`, so a non-terminal entry means the tool is
            // still running and earns the longer deadline.
            ctx.activeToolCallIds.add(event.toolCall.toolCallId);
          }
        }
        ctx.lastTurnActivityAtNanos = activityAtNanos;
      } finally {
        // Decrement before signaling. The watchdog treats in-flight updates as
        // a pause; if it consumed a signal while the counter was still > 0 it
        // would wait on the next take with no follow-up wake after this
        // decrement.
        ctx.livenessUpdatesInFlight = Math.max(0, ctx.livenessUpdatesInFlight - 1);
        yield* signalTurnLiveness(ctx, turnId);
      }
    });

    const hasLivenessPause = (ctx: HermesSessionContext) =>
      ctx.pendingApprovals.size > 0 || ctx.livenessUpdatesInFlight > 0;

    const livenessTimeoutFor = (ctx: HermesSessionContext) =>
      ctx.activeToolCallIds.size > 0
        ? {
            milliseconds: activeToolInactivityTimeoutMs,
            nanos: activeToolInactivityTimeoutNanos,
          }
        : { milliseconds: turnInactivityTimeoutMs, nanos: turnInactivityTimeoutNanos };

    const signalSessionTurnLiveness = (threadId: ThreadId, turnId: TurnId | undefined) => {
      const ctx = sessions.get(threadId);
      return ctx && turnId !== undefined ? signalTurnLiveness(ctx, turnId) : Effect.void;
    };

    const resumeSessionTurnLiveness = Effect.fn("HermesAdapter.resumeSessionTurnLiveness")(
      function* (threadId: ThreadId, turnId: TurnId | undefined) {
        const ctx = sessions.get(threadId);
        if (!ctx || turnId === undefined || ctx.livenessTurnId !== turnId) {
          return;
        }
        // An approval wait can outlast the watchdog — Hermes gives the user a
        // full 60s before it times the request out itself. Resolving it gives
        // the provider a fresh window to resume output.
        ctx.lastTurnActivityAtNanos = yield* Clock.monotonicTimeNanos;
        yield* signalTurnLiveness(ctx, turnId);
      },
    );

    const refreshSessionTurnLiveness = Effect.fn("HermesAdapter.refreshSessionTurnLiveness")(
      function* (threadId: ThreadId, turnId: TurnId | undefined) {
        const ctx = sessions.get(threadId);
        if (
          !ctx ||
          turnId === undefined ||
          ctx.livenessTurnId !== turnId ||
          ctx.lastTurnActivityAtNanos === undefined
        ) {
          return;
        }
        ctx.lastTurnActivityAtNanos = yield* Clock.monotonicTimeNanos;
        yield* signalTurnLiveness(ctx, turnId);
      },
    );

    const markPromptResponseReady = Effect.fn("HermesAdapter.markPromptResponseReady")(function* (
      threadId: ThreadId,
      acpSessionId: string,
      turnId: TurnId,
    ) {
      const ctx = sessions.get(threadId);
      if (
        ctx &&
        ctx.acpSessionId === acpSessionId &&
        !ctx.stopped &&
        !ctx.interruptedTurnIds.has(turnId) &&
        ctx.livenessTurnId === turnId &&
        ctx.activeTurnId === turnId &&
        ctx.session.activeTurnId === turnId
      ) {
        ctx.promptResponsesReady += 1;
        yield* signalTurnLiveness(ctx, turnId);
      }
    });

    const consumePromptResponseReady = (ctx: HermesSessionContext) => {
      ctx.promptResponsesReady = Math.max(0, ctx.promptResponsesReady - 1);
    };

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      settleOptions?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = hermesPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (settleOptions?.emitTurnCompletion !== false) {
            if (settleOptions?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: settleOptions.errorMessage,
                },
              });
            } else if (settleOptions?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state:
                    settleOptions.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: settleOptions.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (settleOptions?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              yield* clearTurnLiveness(liveCtx);
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        yield* clearTurnLiveness(liveCtx);
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn =
          settleOptions?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          settleOptions?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (settleOptions?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: settleOptions.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: settleOptions.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: settleOptions.completedStopReason ?? null,
            },
          });
        }
      });

    const isLiveTurn = (ctx: HermesSessionContext, turnId: TurnId) =>
      ctx.promptsInFlight > 0 &&
      ctx.promptsInFlight > ctx.promptResponsesReady &&
      ctx.activeTurnId === turnId &&
      ctx.session.activeTurnId === turnId &&
      (ctx.session.status === "running" || ctx.session.status === "connecting");

    const settleStalledTurn = Effect.fn("HermesAdapter.settleStalledTurn")(function* (
      ctx: HermesSessionContext,
      turnId: TurnId,
    ) {
      return yield* withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          const liveCtx = sessions.get(ctx.threadId);
          if (
            liveCtx !== ctx ||
            ctx.stopped ||
            !isLiveTurn(ctx, turnId) ||
            ctx.interruptedTurnIds.has(turnId) ||
            hasLivenessPause(ctx)
          ) {
            return;
          }
          const lastActivityAtNanos = ctx.lastTurnActivityAtNanos;
          if (lastActivityAtNanos === undefined) {
            return;
          }
          const nowNanos = yield* Clock.monotonicTimeNanos;
          if (
            ctx.interruptedTurnIds.has(turnId) ||
            !isLiveTurn(ctx, turnId) ||
            hasLivenessPause(ctx) ||
            nowNanos - lastActivityAtNanos < livenessTimeoutFor(ctx).nanos
          ) {
            return;
          }

          // Mark before cancel/drain so notifications already in flight finish
          // before the terminal event, while late notifications are dropped.
          ctx.interruptedTurnIds.add(turnId);
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/cancel", error),
              ),
            ),
          );
          yield* Effect.ignore(ctx.acp.drainEvents);
          yield* settlePromptInFlight(ctx.threadId, turnId, ctx.acpSessionId, {
            errorMessage: `Hermes ACP turn stalled without content or tool progress for ${livenessTimeoutFor(ctx).milliseconds}ms.`,
            settleAllPrompts: true,
          });
        }),
      );
    });

    const runTurnLivenessWatchdog = Effect.fn("HermesAdapter.runTurnLivenessWatchdog")(
      function* (ctx: HermesSessionContext) {
        while (true) {
          if (ctx.stopped) {
            return;
          }
          const turnId = ctx.livenessTurnId;
          if (
            turnId === undefined ||
            ctx.interruptedTurnIds.has(turnId) ||
            !isLiveTurn(ctx, turnId) ||
            hasLivenessPause(ctx)
          ) {
            yield* Queue.take(ctx.livenessSignals);
            continue;
          }

          const lastActivityAtNanos = ctx.lastTurnActivityAtNanos;
          if (lastActivityAtNanos === undefined) {
            yield* Queue.take(ctx.livenessSignals);
            continue;
          }
          const nowNanos = yield* Clock.monotonicTimeNanos;
          const remainingNanos = livenessTimeoutFor(ctx).nanos - (nowNanos - lastActivityAtNanos);
          if (remainingNanos <= 0n) {
            yield* settleStalledTurn(ctx, turnId);
            continue;
          }

          const wakeReason = yield* Effect.raceFirst(
            Effect.sleep(Duration.nanos(remainingNanos)).pipe(Effect.as("timeout" as const)),
            Queue.take(ctx.livenessSignals).pipe(Effect.as("activity" as const)),
          );
          if (wakeReason === "timeout") {
            yield* settleStalledTurn(ctx, turnId);
          }
        }
      },
      Effect.catch(() => Effect.void),
    );

    // ── Emission helpers ─────────────────────────────────────────────

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Hermes notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: HermesSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    /**
     * Re-emit the three Hermes notifications the shared runtime model drops.
     * Registered as a second raw `session/update` handler; the parsed
     * turn-content stream is unaffected.
     */
    const handleHermesSessionUpdate = (
      threadId: ThreadId,
      notification: EffectAcpSchema.SessionNotification,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped || ctx.acpSessionId !== notification.sessionId) {
          return;
        }
        const update = notification.update;
        const turnId = resolveNotificationTurnId(ctx);

        const usage = parseHermesUsageUpdate(update);
        if (usage) {
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            ...(turnId ? { turnId } : {}),
            payload: { usage },
            raw: {
              source: "acp.jsonrpc",
              method: "session/update",
              payload: update,
            },
          });
          return;
        }

        const sessionInfo = parseHermesSessionInfo(update);
        if (sessionInfo) {
          const provenanceFingerprint = hermesProvenanceFingerprint(sessionInfo.provenance);
          const titleChanged =
            sessionInfo.title !== undefined && sessionInfo.title !== ctx.lastSessionTitle;
          const provenanceChanged =
            provenanceFingerprint !== undefined &&
            provenanceFingerprint !== ctx.lastProvenanceFingerprint;
          if (!titleChanged && !provenanceChanged) {
            return;
          }
          if (sessionInfo.title !== undefined) {
            ctx.lastSessionTitle = sessionInfo.title;
          }
          if (provenanceFingerprint !== undefined) {
            ctx.lastProvenanceFingerprint = provenanceFingerprint;
          }
          yield* offerRuntimeEvent({
            type: "thread.metadata.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            ...(turnId ? { turnId } : {}),
            payload: {
              ...(sessionInfo.title !== undefined ? { name: sessionInfo.title } : {}),
              ...(sessionInfo.provenance !== undefined
                ? { metadata: { hermesSessionProvenance: sessionInfo.provenance } }
                : {}),
            },
            raw: {
              source: HERMES_EXTENSION_SOURCE,
              method: "session/update",
              payload: update,
            },
          });
          return;
        }

        const availableCommands = parseHermesAvailableCommands(update);
        if (availableCommands.length > 0) {
          yield* offerRuntimeEvent({
            type: "thread.metadata.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            payload: { metadata: { hermesAvailableCommands: availableCommands } },
            raw: {
              source: "acp.jsonrpc",
              method: "session/update",
              payload: update,
            },
          });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to process Hermes session metadata update.", {
            cause,
            threadId,
          }),
        ),
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<HermesSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /**
     * Tear a session down. Hermes implements no `session/close` — the route
     * answers `-32601` — so the ACP session is ended by closing the scope,
     * which kills the child process. Its state lives on in `state.db`, which
     * is what makes the resume cursor meaningful across restarts.
     */
    const stopSessionInternal = (ctx: HermesSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    // ── startSession ─────────────────────────────────────────────────

    const startSession: HermesAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          // Instance-scoped: never apply another instance's model selection.
          const hermesModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionApprovedOperations = new Set<string>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseHermesResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          // Best-effort: an unwritable or malformed config.yaml logs a
          // warning and never blocks the session from starting. FileSystem
          // and Path are provided explicitly from the services this adapter
          // already resolved at construction time, rather than re-requiring
          // them here.
          yield* syncHermesCommandRules(
            hermesSettings,
            options?.environment ?? process.env,
            cwd,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeHermesAcpRuntime({
            hermesSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            // Hermes registers session-scoped MCP servers from `session/new`
            // and refreshes its tool surface, even though `initialize` reports
            // `mcpCapabilities.http: false` — the capability block is
            // under-declared relative to `_register_session_mcp_servers`.
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleSessionUpdate((notification) =>
              handleHermesSessionUpdate(input.threadId, notification),
            );
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  const permissionRequest = parsePermissionRequest(params);
                  const approvalKey = hermesApprovalKey(params.toolCall);
                  const alreadyApproved =
                    approvalKey !== undefined && sessionApprovedOperations.has(approvalKey);
                  // Hermes' session modes gate file edits only; shell commands
                  // always reach this handler. Full-access is therefore the
                  // only thing that keeps a `dont_ask` session from stopping
                  // on every `terminal` call.
                  if (input.runtimeMode === "full-access" || alreadyApproved) {
                    const autoApprovedOptionId =
                      input.runtimeMode === "full-access"
                        ? selectAutoApprovedPermissionOption(params)
                        : selectHermesPermissionOptionId(params, "accept");
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* signalSessionTurnLiveness(input.threadId, turnId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* resumeSessionTurnLiveness(input.threadId, turnId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel"
                      ? undefined
                      : selectHermesPermissionOptionId(params, resolved);
                  if (
                    (resolved === "acceptForSession" || resolved === "acceptAlways") &&
                    selectedOptionId &&
                    approvalKey !== undefined
                  ) {
                    sessionApprovedOperations.add(approvalKey);
                  }
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          // Permission mode is session state in Hermes, so it is applied here
          // rather than encoded in the spawn arguments.
          const boundModeId = yield* applyHermesAcpSessionMode({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
          });

          const requestedStartModelId = hermesModelSelection?.model
            ? resolveHermesAcpBaseModelId(hermesModelSelection.model)
            : undefined;
          const currentStartModelId = currentHermesModelIdFromSessionSetup(
            started.sessionSetupResult,
          );
          const boundModelId = yield* applyHermesAcpModelSelection({
            runtime: acp,
            currentModelId: currentStartModelId,
            requestedModelId: requestedStartModelId,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveHermesAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: HERMES_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: HermesSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            livenessSignals: yield* Queue.sliding<HermesTurnLivenessSignal>(1),
            livenessTurnId: undefined,
            lastTurnActivityAtNanos: undefined,
            activeToolCallIds: new Set(),
            livenessUpdatesInFlight: 0,
            promptResponsesReady: 0,
            currentModelId: boundModelId,
            currentModeId: boundModeId,
            // Seeded from session setup: `session/new` and `session/resume`
            // both carry provenance, so a resumed thread does not re-announce
            // a compaction that happened before this process started.
            lastProvenanceFingerprint: hermesProvenanceFingerprint(
              parseHermesSessionProvenance(started.sessionSetupResult),
            ),
            lastSessionTitle: undefined,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                // Hermes never emits `current_mode_update`, so this arm only
                // fires if a future release starts to. Recording it keeps the
                // optimistic value honest if that happens.
                if (event._tag === "ModeChanged") {
                  ctx.currentModeId = event.modeId;
                  return;
                }

                const notificationTurnId = resolveNotificationTurnId(ctx);
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                if (
                  event._tag === "AssistantItemStarted" ||
                  event._tag === "AssistantItemCompleted" ||
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta"
                ) {
                  yield* recordTurnActivity(ctx, notificationTurnId, event);
                }
                const stamp = yield* makeEventStamp();

                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Hermes runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber: Effect
            // interrupts a fiber's children when it completes, so a child of
            // `startSession` would die the moment `startSession` returned and
            // every later notification would be dropped.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          yield* runTurnLivenessWatchdog(ctx).pipe(Effect.forkIn(ctx.scope), Effect.asVoid);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Hermes ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    // ── sendTurn ─────────────────────────────────────────────────────

    const sendTurn: HermesAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            // A sendTurn while a prompt is in flight is a steer. Hermes agrees:
            // it either redirects the live turn or queues the prompt behind it
            // (`server.py:1877`), so the active turn id is reused rather than
            // opening a second turn the agent does not believe exists.
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveHermesAcpBaseModelId(turnModelSelection.model)
                : undefined;

              const text = input.input?.trim();
              // Hermes declares `promptCapabilities.image: true` and nothing
              // else; audio blocks are accepted by its type union but silently
              // dropped, and embedded resources are declared unsupported. So
              // images are the only attachment sent inline — other files reach
              // the agent through the path line ProviderService puts in the
              // prompt, and Hermes reads them with its own `read_file` tool.
              const imagePromptParts = yield* Effect.forEach(
                (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    return {
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              const currentModelId = yield* applyHermesAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });
              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId
                ? resolveHermesAcpBaseModelId(currentModelId)
                : undefined;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Hermes prompt was interrupted during preparation.",
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };
              if (steeringTurnId === undefined) {
                yield* beginTurnLiveness(ctx, turnId);
              } else {
                yield* refreshSessionTurnLiveness(input.threadId, turnId);
              }

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Hermes prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );
        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          const result = yield* prepared.acp
            .prompt({
              prompt: prepared.promptParts,
            })
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all(
                  [
                    Ref.set(promptRpcSucceeded, true),
                    Ref.set(promptResultRef, promptResult),
                    markPromptResponseReady(input.threadId, prepared.acpSessionId, prepared.turnId),
                  ],
                  { discard: true },
                ),
              ),
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
                ).pipe(Effect.andThen(prepared.acp.drainEvents)),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "Hermes session changed before the turn completed.",
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Hermes session changed before the turn completed.",
                });
              }
              // Keep prompt settlement atomic with respect to Stop and
              // steering. interruptTurn marks its target before waiting for
              // this lock, so cancellation can still win while queued ACP
              // events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* prepared.acp.drainEvents;
              consumePromptResponseReady(ctx);
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remainingPrompts;

              // Only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight must
              // leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              ) {
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                yield* clearTurnLiveness(ctx);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: result.stopReason,
                  },
                });
                ctx.interruptedTurnIds.delete(prepared.turnId);
                yield* Ref.set(promptSettled, true);
              } else if (remainingPrompts > 0) {
                yield* Ref.set(promptSettled, true);
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "Hermes session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    consumePromptResponseReady(ctx);
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      { completedStopReason: promptResult.stopReason },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? "Hermes prompt request failed.",
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    // ── Remaining shape methods ──────────────────────────────────────

    const interruptTurn: HermesAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            // Marked synchronously, before waiting on the thread lock, so a
            // racing prompt settlement loses.
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
              yield* clearTurnLiveness(ctx);
            }
          }),
        );
      });

    const respondToRequest: HermesAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    /**
     * Hermes has no structured user-input channel. It implements no ACP
     * extension methods at all — `ext_method` is absent from the agent, so any
     * `_`-prefixed request is answered `-32601` — and asks the user questions
     * as ordinary assistant text instead. Nothing can ever be pending here.
     */
    const respondToUserInput: HermesAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_user_input",
          detail: `Hermes does not issue structured user-input requests; nothing is pending for ${requestId}.`,
        });
      });

    const readThread: HermesAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    /**
     * Hermes exposes `session/fork` but no rollback: forking branches a session
     * forward from its full history rather than truncating it, so it cannot
     * implement "drop the last N turns".
     */
    const rollbackThread: HermesAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Hermes ACP sessions do not support provider-side rollback.",
        });
      });

    const stopSession: HermesAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: HermesAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: HermesAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: HermesAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies HermesAdapterShape;
  });
}
