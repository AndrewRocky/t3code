import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";

function promptText(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  if (Reflect.get(frame, "method") !== "session/prompt") return undefined;
  const params = Reflect.get(frame, "params");
  const prompt = typeof params === "object" && params !== null ? Reflect.get(params, "prompt") : [];
  const first = Array.isArray(prompt) ? prompt[0] : undefined;
  const text = typeof first === "object" && first !== null ? Reflect.get(first, "text") : undefined;
  return typeof text === "string" ? text : undefined;
}

/**
 * Hermes steers with its `/steer` command as a second prompt while the first
 * is open. The steer lands in the running turn: no cancel, one provider turn.
 */
export function assertHermesMessageSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  assert.include(
    outbound.map(promptText),
    `/steer ${MESSAGE_STEERING_STEER_PROMPT}`,
    "the steer must reach Hermes as /steer",
  );
  assert.isFalse(
    outbound.some(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        Reflect.get(frame, "method") === "session/cancel",
    ),
    "steering must not cancel the running Hermes turn",
  );

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_INITIAL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");
  assert.lengthOf(projection.providerTurns, 1, "active steering must not start a provider turn");
  assert.equal(projection.providerTurns[0]?.status, "completed");
}
