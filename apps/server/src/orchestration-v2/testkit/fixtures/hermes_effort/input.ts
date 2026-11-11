import type { OrchestratorFixtureInput } from "../shared.ts";

export const HERMES_EFFORT_PROMPT = "Respond with exactly: hermes effort";
export const HERMES_EFFORT_LEVEL = "high";

/** One turn at the reasoning effort picked in the thread's model selection. */
export function hermesEffortInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: HERMES_EFFORT_PROMPT }] };
}
