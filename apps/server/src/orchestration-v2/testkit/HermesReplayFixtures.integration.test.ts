import { describe } from "@effect/vitest";

import { HermesOrchestratorReplayHarness } from "../Adapters/HermesAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Hermes replay fixtures", () => {
  itRunsReplayFixtures("hermes", (input) =>
    runReplayFixture({ ...input, harness: HermesOrchestratorReplayHarness }),
  );
});
