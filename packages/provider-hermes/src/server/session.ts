import type { OrchestrationV2TurnItem, RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  HERMES_DRIVER_KIND,
  hermesLaunchRuntimeMode,
  hermesModeIdForRuntimeMode,
} from "./acpSupport.ts";
import type { HermesRuntimeRegistry } from "./runtime.ts";

// The session decorator spreads the shared adapter's session object and
// overrides single members, the way upstream decorates Grok's runtime. It
// relies on the orchestrator calling `steerTurn` only for a running turn, in
// the same FIFO effect lane as Stop.

type Adapter = ProviderAdapter.ProviderAdapterV2["Service"];
type Session = ProviderAdapter.ProviderAdapterV2SessionRuntime;

const STEER_ACK_PREFIX = "⏩";

/** The launcher stops the server five seconds after asking; T3's own turn gets most of that. */
const RELEASE_STOP_BOUND = "3 seconds";

/** Hermes' own checks still ask under YOLO (sensitive paths, plugin approvals, model switches). */
const FULL_ACCESS_PROVIDER_CHECK_REASON =
  "Full access lets Hermes run commands without asking, but Hermes still asks before touching sensitive paths and for its own approval checks.";

export interface HermesSessionDecoratorOptions {
  readonly registry: HermesRuntimeRegistry;
  /** Work Hermes is doing for this thread that outlives the turn, such as background subagents. */
  readonly pendingBackgroundWork?: (threadId: string) => Effect.Effect<boolean>;
}

function stampFullAccessApproval(
  item: OrchestrationV2TurnItem,
  runtimeMode: RuntimeMode,
): OrchestrationV2TurnItem {
  if (item.type !== "approval_request" || runtimeMode !== "full-access") return item;
  if (item.fullAccessOverride !== undefined) return item;
  return {
    ...item,
    fullAccessOverride: "provider_check",
    reason: item.reason ?? FULL_ACCESS_PROVIDER_CHECK_REASON,
  };
}

const interruptRefused = (input: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
  new ProviderAdapter.ProviderAdapterInterruptError({
    driver: HERMES_DRIVER_KIND,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.providerTurnId,
    cause: new Error(
      "Hermes is finishing a turn this T3 Code session did not start, which T3 Code cannot stop on this Hermes version. It ends when Hermes finishes.",
    ),
  });

const rollbackRefused = (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
  new ProviderAdapter.ProviderAdapterRollbackThreadError({
    driver: HERMES_DRIVER_KIND,
    providerThreadId: input.providerThread.id,
    cause: new Error("Hermes is still working on this thread. Try again once it has finished."),
  });

const steerFailure = (input: ProviderAdapter.ProviderAdapterV2SteerInput, detail: string) =>
  new ProviderAdapter.ProviderAdapterSteerRunError({
    driver: HERMES_DRIVER_KIND,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.providerTurnId,
    cause: new Error(detail),
  });

function decorateSession(
  session: Session,
  openInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  options: HermesSessionDecoratorOptions,
): Session {
  const threadId = openInput.threadId;
  let runtimeMode: RuntimeMode = hermesLaunchRuntimeMode(openInput.runtimePolicy);

  /**
   * The shared adapter applies the policy mode only when it activates a
   * session or the model changes, so a runtime-mode change alone is applied
   * here, before the turn's prompt goes out.
   */
  const applyRuntimeMode = Effect.fn("HermesSession.applyRuntimeMode")(function* (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  ) {
    const next = hermesLaunchRuntimeMode(policy);
    if (next === runtimeMode) return;
    runtimeMode = next;
    const handle = options.registry.get(threadId);
    if (handle === undefined || handle.sessionId() === undefined) return;
    yield* handle.runtime
      .setMode(hermesModeIdForRuntimeMode(next))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Hermes did not accept the new permission mode.", { cause }),
        ),
      );
  });

  /**
   * `/steer` with nothing running falls through to a normal submit, and with
   * T3's prompt still queued behind other work it becomes another queued
   * prompt, so it is sent only while this viewer's own prompt is open.
   */
  const steerTurn: Session["steerTurn"] = Effect.fn("HermesSession.steerTurn")(function* (input) {
    const handle = options.registry.get(input.threadId);
    // With other prompts queued, T3's own may be among them rather than running.
    const queued = handle?.ownPromptOpen() === true ? yield* handle.queuedAdmissions() : undefined;
    if (handle === undefined || !handle.ownPromptOpen() || (queued ?? 0) > 0) {
      return yield* steerFailure(
        input,
        "Hermes has not started this turn yet, so it cannot be steered. Send the message as a follow-up instead.",
      );
    }
    if (input.message.attachments.length > 0) {
      return yield* steerFailure(input, "Hermes cannot steer a running turn with attachments.");
    }
    const reply = yield* handle
      .controlPrompt(`/steer ${input.message.text}`)
      .pipe(Effect.mapError((cause) => steerFailure(input, cause.message)));
    if (!reply.trimStart().startsWith(STEER_ACK_PREFIX)) {
      yield* Effect.logWarning("Hermes did not acknowledge a steer.", { reply });
    }
  });

  /** Stop reaches only this viewer's own turn; anything else would be reported stopped and keep running. */
  const interruptTurn: Session["interruptTurn"] = Effect.fn("HermesSession.interruptTurn")(
    function* (input) {
      const handle = options.registry.get(threadId);
      if (handle !== undefined && (yield* handle.workState()) === "foreign") {
        return yield* interruptRefused(input);
      }
      return yield* session.interruptTurn(input);
    },
  );

  /** A reset rollback replaces the viewer, and the old session would keep running. */
  const rollbackThread: Session["rollbackThread"] = Effect.fn("HermesSession.rollbackThread")(
    function* (input) {
      const handle = options.registry.get(threadId);
      const state = handle === undefined ? "idle" : yield* handle.workState();
      if (state === "own" || state === "foreign") return yield* rollbackRefused(input);
      return yield* session.rollbackThread(input);
    },
  );

  const hermesBusy = Effect.suspend(() => {
    const handle = options.registry.get(threadId);
    return handle === undefined
      ? Effect.succeed(false)
      : handle.workState().pipe(Effect.map((state) => state === "own" || state === "foreign"));
  });

  return {
    ...session,
    events: session.events.pipe(
      Stream.map((event) =>
        event.type === "turn_item.updated"
          ? { ...event, turnItem: stampFullAccessApproval(event.turnItem, runtimeMode) }
          : event,
      ),
    ),
    // The idle reaper would otherwise kill a viewer whose session Hermes is still running.
    hasPendingBackgroundWork: Effect.gen(function* () {
      if (
        session.hasPendingBackgroundWork !== undefined &&
        (yield* session.hasPendingBackgroundWork)
      )
        return true;
      if (
        options.pendingBackgroundWork !== undefined &&
        (yield* options.pendingBackgroundWork(threadId))
      )
        return true;
      return yield* hermesBusy;
    }),
    startTurn: (input) => {
      // Recovery attaches before it prompts; the runtime adopts a turn Hermes still runs.
      const recovery = input.restartContinuationOfRunId === undefined ? undefined : input.threadId;
      return Effect.sync(() => {
        if (recovery !== undefined) options.registry.expectRestartRecovery(recovery);
      }).pipe(
        Effect.andThen(applyRuntimeMode(input.runtimePolicy)),
        Effect.andThen(session.startTurn(input)),
        Effect.onError(() =>
          Effect.sync(() => {
            if (recovery !== undefined) options.registry.clearRestartRecovery(recovery);
          }),
        ),
      );
    },
    steerTurn,
    interruptTurn,
    rollbackThread,
  };
}

/**
 * Releasing a session closes the viewer, which stops nothing: Hermes would
 * finish T3's turn with nobody watching. Archive, errors and shutdown stop it
 * first, within a budget, since T3 cannot hold a release open.
 */
const stopBeforeRelease = (threadId: string, registry: HermesRuntimeRegistry) =>
  Effect.suspend(() => {
    const handle = registry.get(threadId);
    if (handle === undefined || !handle.ownPromptOpen()) return Effect.void;
    return handle.stopOwnTurn(RELEASE_STOP_BOUND).pipe(
      Effect.flatMap((stopped) =>
        stopped
          ? Effect.void
          : Effect.logWarning("Hermes was still working when T3 Code released its session.", {
              threadId,
            }),
      ),
    );
  });

export function decorateHermesAdapter(
  adapter: Adapter,
  options: HermesSessionDecoratorOptions,
): Adapter {
  return {
    ...adapter,
    openSession: (input) =>
      adapter.openSession(input).pipe(
        // Added after the base session's own finalizers, so it runs before they close the viewer.
        Effect.tap(() =>
          Effect.addFinalizer(() => stopBeforeRelease(input.threadId, options.registry)),
        ),
        Effect.map((session) => decorateSession(session, input, options)),
      ),
  };
}
