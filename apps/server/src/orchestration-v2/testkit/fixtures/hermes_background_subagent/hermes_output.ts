import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { GROK_BACKGROUND_SUBAGENT_PROMPT } from "../grok_background_subagent/input.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";

function runAssistantTexts(
  projection: ReturnType<typeof projectionFor>,
  runId: string | undefined,
): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

// Hermes' delegate_task returns at dispatch, so the root run ends first. The
// subagent row stays running until Hermes' ledger records its result; Hermes
// then reads the result in a turn of its own, which becomes run 2.
export function assertHermesBackgroundSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [GROK_BACKGROUND_SUBAGENT_PROMPT]);
  const [rootRun, wakeRun] = projection.runs;

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.origin, "provider_native");
  assert.equal(subagent?.runId, rootRun?.id, "the subagent belongs to the run that spawned it");
  assert.include(runAssistantTexts(projection, rootRun?.id), "ROOT_DONE");

  const rootCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "completed",
  );
  const subagentCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "subagent" &&
      event.payload.status === "completed",
  );
  const wakeStartedAt = result.domainEvents.findIndex(
    (event) => event.type === "run.updated" && event.payload.id === wakeRun?.id,
  );
  assert.isAtLeast(rootCompletedAt, 0);
  assert.isAbove(subagentCompletedAt, rootCompletedAt, "the root run ends at dispatch");
  assert.isAbove(wakeStartedAt, subagentCompletedAt, "Hermes reads the result after it lands");

  assert.deepEqual(
    backgroundNotifications(projection).map((notification) => notification.outcome),
    ["completed"],
  );

  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.isTrue(
    runAssistantTexts(projection, wakeRun?.id).some((text) => text.includes("SUBAGENT_DONE")),
    "Hermes' reply to the finished subagent must land in the continuation run",
  );
}
