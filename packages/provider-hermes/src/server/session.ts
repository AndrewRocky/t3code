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
    if (handle === undefined || !handle.ownPromptOpen()) {
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

  return {
    ...session,
    events: session.events.pipe(
      Stream.map((event) =>
        event.type === "turn_item.updated"
          ? { ...event, turnItem: stampFullAccessApproval(event.turnItem, runtimeMode) }
          : event,
      ),
    ),
    ...(options.pendingBackgroundWork === undefined
      ? {}
      : {
          hasPendingBackgroundWork: Effect.gen(function* () {
            const base = session.hasPendingBackgroundWork
              ? yield* session.hasPendingBackgroundWork
              : false;
            return base || (yield* options.pendingBackgroundWork!(threadId));
          }),
        }),
    startTurn: (input) =>
      applyRuntimeMode(input.runtimePolicy).pipe(Effect.andThen(session.startTurn(input))),
    steerTurn,
  };
}

export function decorateHermesAdapter(
  adapter: Adapter,
  options: HermesSessionDecoratorOptions,
): Adapter {
  return {
    ...adapter,
    openSession: (input) =>
      adapter
        .openSession(input)
        .pipe(Effect.map((session) => decorateSession(session, input, options))),
  };
}
