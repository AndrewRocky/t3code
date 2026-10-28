import type { OrchestratorFixtureInput } from "../shared.ts";
import { GROK_BACKGROUND_SUBAGENT_PROMPT } from "../grok_background_subagent/input.ts";

/** The recorder's label for the first frame of the turn Hermes starts on its own. */
const HERMES_WAKE_LABEL = "hermes-wake-1";

// Hermes ends the root turn as soon as the subagent is dispatched. The ledger
// reports the subagent done on the watcher's next poll, and only then is
// Hermes' own result turn released; it settles once Hermes goes quiet.
export function hermesBackgroundSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_SUBAGENT_PROMPT },
      { type: "advance_clock", duration: "2 seconds" },
      { type: "release_replay_gate", label: HERMES_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
