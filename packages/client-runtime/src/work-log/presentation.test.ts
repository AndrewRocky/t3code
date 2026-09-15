import { describe, expect, it } from "vite-plus/test";

import {
  summarizeToolGroup,
  toolGroupAction,
  workLogEntryIsLocalCodeSearch,
  type WorkLogPresentationEntry,
} from "./presentation.ts";

function searchEntry(overrides: Partial<WorkLogPresentationEntry> = {}): WorkLogPresentationEntry {
  return {
    // Every ACP search row looks like this by the time it reaches a client:
    // `canonicalItemTypeFromAcpToolKind` maps both `search` and `fetch` onto
    // `web_search`, and `deriveToolActivityPresentation` has already replaced
    // the agent's own title with the generic summary.
    label: "Searched files",
    toolTitle: "Searched files",
    tone: "tool",
    itemType: "web_search",
    ...overrides,
  };
}

describe("workLogEntryIsLocalCodeSearch", () => {
  it("counts a Hermes workspace search as a code search, not a web search", () => {
    const entry = searchEntry({ searchScope: "workspace" });

    expect(workLogEntryIsLocalCodeSearch(entry)).toBe(true);
    expect(toolGroupAction(entry)).toBe("code-search");
    expect(summarizeToolGroup([entry])).toBe("Searched code 1 time");
    expect(summarizeToolGroup([entry, entry, entry])).toBe("Searched code 3 times");
  });

  it("leaves a search row the adapter scoped to the network alone", () => {
    const entry = searchEntry({ searchScope: "network" });

    expect(workLogEntryIsLocalCodeSearch(entry)).toBe(false);
    expect(summarizeToolGroup([entry])).toBe("Searched the web 1 time");
  });

  it("leaves every provider that scopes nothing exactly as it was", () => {
    // Only an adapter that knows its own agent sets `searchScope`. Today that
    // is Hermes alone: `hermesToolCallAugment` is wired into the Hermes ACP
    // runtime and nothing else. Claude, Codex, OpenCode, Cursor and Grok all
    // produce rows without it, and must keep the label they had before.
    //
    // Cursor matters specifically: cursor-agent tags its built-in *web* search
    // with ACP `kind: "search"`, so a rule keyed on the raw kind would have
    // relabelled a genuine web search as a code search.
    for (const entry of [
      searchEntry({ label: "Web search", toolTitle: "Web search" }),
      searchEntry({ label: "Searched files", toolTitle: "Searched files" }),
    ]) {
      expect(workLogEntryIsLocalCodeSearch(entry)).toBe(false);
      expect(summarizeToolGroup([entry])).toBe("Searched the web 1 time");
    }
  });

  it("still honours the legacy grep title heuristic when no scope is present", () => {
    const entry = searchEntry({ label: "Grep", toolTitle: "Grep" });

    expect(workLogEntryIsLocalCodeSearch(entry)).toBe(true);
    expect(summarizeToolGroup([entry])).toBe("Searched code 1 time");
  });

  it("ignores a scope on a row that is not a search at all", () => {
    const entry: WorkLogPresentationEntry = {
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      command: "pnpm test",
      searchScope: "workspace",
    };

    expect(workLogEntryIsLocalCodeSearch(entry)).toBe(false);
    expect(toolGroupAction(entry)).toBe("command");
  });
});
