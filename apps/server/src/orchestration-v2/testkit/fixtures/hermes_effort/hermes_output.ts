import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { HERMES_EFFORT_LEVEL, HERMES_EFFORT_PROMPT } from "./input.ts";

interface ConfigOption {
  readonly id?: unknown;
  readonly currentValue?: unknown;
}
interface Frame {
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly params?: {
    readonly configId?: unknown;
    readonly value?: unknown;
    readonly update?: { readonly configOptions?: ReadonlyArray<ConfigOption> };
  };
  readonly result?: { readonly configOptions?: ReadonlyArray<ConfigOption> };
}

const effortOf = (configOptions: ReadonlyArray<ConfigOption> | undefined) =>
  configOptions?.find((option) => option.id === "reasoning_effort")?.currentValue;

/** T3 writes Hermes' `reasoning_effort` once, before the prompt, and Hermes reports it back. */
export function assertHermesEffortOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [HERMES_EFFORT_PROMPT]);

  const frames = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" || entry.type === "emit_inbound"
      ? [{ direction: entry.type, frame: entry.frame as Frame }]
      : [],
  );
  const effortWrites = frames.flatMap(({ direction, frame }, index) =>
    direction === "expect_outbound" &&
    frame.method === "session/set_config_option" &&
    frame.params?.configId === "reasoning_effort"
      ? [{ index, value: frame.params.value }]
      : [],
  );
  const prompt = frames.findIndex(
    ({ direction, frame }) => direction === "expect_outbound" && frame.method === "session/prompt",
  );
  assert.deepEqual(
    effortWrites.map((write) => write.value),
    [HERMES_EFFORT_LEVEL],
  );
  const effortWrite = effortWrites[0]?.index ?? -1;
  assert.isBelow(effortWrite, prompt);
  const reported = frames
    .slice(effortWrite, prompt)
    .flatMap(({ direction, frame }) =>
      direction === "emit_inbound"
        ? [effortOf(frame.result?.configOptions ?? frame.params?.update?.configOptions)]
        : [],
    )
    .filter((value) => value !== undefined);
  assert.equal(reported.at(-1), HERMES_EFFORT_LEVEL);
}
