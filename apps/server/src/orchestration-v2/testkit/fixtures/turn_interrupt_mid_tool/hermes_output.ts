import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../shared.ts";

function frameMethod(frame: unknown): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, "method") : undefined;
}

function sessionUpdateType(frame: unknown): unknown {
  if (frameMethod(frame) !== "session/update") return undefined;
  const params = Reflect.get(frame as object, "params");
  const update =
    typeof params === "object" && params !== null ? Reflect.get(params, "update") : undefined;
  return typeof update === "object" && update !== null
    ? Reflect.get(update, "sessionUpdate")
    : undefined;
}

/** The run ends only once Hermes returns the prompt it cancelled, never on a timeout. */
export function assertTurnInterruptMidToolHermesOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const toolStartIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && sessionUpdateType(entry.frame) === "tool_call",
  );
  const cancelIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && frameMethod(entry.frame) === "session/cancel",
  );
  assert.isAtLeast(toolStartIndex, 0, "Hermes must record the terminal tool starting");
  assert.isAbove(cancelIndex, toolStartIndex, "Stop must cancel after the tool started");

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "assistant_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_MID_TOOL_PROMPT]);

  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(commandItem);
  assert.include(commandItem.input, "node -e");
  assert.equal(commandItem.status, "interrupted");
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.equal(interruptResult?.status, "interrupted");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted"],
  );
}
