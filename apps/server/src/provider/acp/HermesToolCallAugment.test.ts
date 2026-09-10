import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import { parseSessionUpdateEvent, type AcpToolCallState } from "./AcpRuntimeModel.ts";
import { hermesToolCallAugment } from "./HermesToolCallAugment.ts";

/**
 * Every fixture below is the frame `hermes-agent@9fd44b4` actually emits, taken
 * from `acp_adapter/tools.py` `_TITLE_BUILDERS` / `_START_CONTENT_BUILDERS` /
 * `_build_tool_start`. The point of these tests is that the fixtures stay
 * faithful: `rawInput` and `rawOutput` are `null` for every native tool.
 */
function parseHermesToolCall(
  update: EffectAcpSchema.SessionNotification["update"],
): AcpToolCallState {
  const parsed = parseSessionUpdateEvent(
    { sessionId: "session-1", update } as EffectAcpSchema.SessionNotification,
    { toolCallAugment: hermesToolCallAugment },
  );
  const [event] = parsed.events;
  if (event?._tag !== "ToolCallUpdated") {
    throw new Error("expected a tool call event");
  }
  return event.toolCall;
}

function textContent(text: string): EffectAcpSchema.ToolCallContent {
  return { type: "content", content: { type: "text", text } } as EffectAcpSchema.ToolCallContent;
}

describe("hermesToolCallAugment", () => {
  it("recovers a terminal command from the start content block, not the clipped title", () => {
    const command =
      "pnpm test --filter web --reporter=verbose --run apps/web/src/components/chat/MessagesTimeline.test.tsx";
    const toolCall = parseHermesToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      // Hermes clips the title at 80 chars; the content block carries the command whole.
      title: `terminal: ${command.slice(0, 77)}...`,
      kind: "execute",
      content: [textContent(`$ ${command}`)],
    });

    expect(toolCall.command).toBe(command);
    expect(toolCall.detail).toBe(command);
    expect(toolCall.data.command).toBe(command);
  });

  it("falls back to the terminal title when there is no start content block", () => {
    const toolCall = parseHermesToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "tc-2",
      title: "terminal: git status --porcelain",
      kind: "execute",
    });

    expect(toolCall.command).toBe("git status --porcelain");
  });

  it("keeps the command across the terminal update, which resends neither title nor input", () => {
    const started = parseHermesToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "tc-3",
      title: "terminal: pnpm test",
      kind: "execute",
      content: [textContent("$ pnpm test")],
    });
    // Hermes' terminal frame: id, kind, status, content. Nothing else.
    const completed = parseHermesToolCall({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-3",
      kind: "execute",
      status: "failed",
      content: [textContent("terminal result\n- **output:** 1 failed\n- **exit_code:** 1")],
    });

    expect(started.command).toBe("pnpm test");
    // The completion frame alone carries no command; AcpSessionRuntime merges
    // it forward from the start frame, which is why recovery has to happen on
    // the start frame to be worth anything.
    expect(completed.command).toBeUndefined();
    expect(completed.status).toBe("failed");
  });

  it("keeps Hermes' own label for searches, skills and delegation", () => {
    const cases: ReadonlyArray<{
      readonly title: string;
      readonly kind: string;
      readonly summary: string;
    }> = [
      {
        title: "web search: effect-ts Layer composition",
        kind: "fetch",
        summary: "Searched files",
      },
      { title: "search: useEffect\\(", kind: "search", summary: "Searched files" },
      { title: "skill view (dataviz/SKILL.md)", kind: "read", summary: "Read file" },
      { title: "delegate: audit the ACP adapter", kind: "execute", summary: "Ran command" },
      { title: "python: import pandas as pd", kind: "execute", summary: "Ran command" },
      { title: "memory add: project-conventions", kind: "execute", summary: "Ran command" },
    ];

    for (const { title, kind, summary } of cases) {
      const toolCall = parseHermesToolCall({
        sessionUpdate: "tool_call",
        toolCallId: `tc-${title}`,
        title,
        kind,
      } as EffectAcpSchema.SessionNotification["update"]);
      expect(toolCall.title).toBe(summary);
      expect(toolCall.detail).toBe(title);
    }
  });

  it("prefers a path read out of locations over the title for a file read", () => {
    const toolCall = parseHermesToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "tc-read",
      title: "read: apps/server/src/provider/acp/AcpRuntimeModel.ts",
      kind: "read",
      locations: [{ path: "apps/server/src/provider/acp/AcpRuntimeModel.ts" }],
    });

    expect(toolCall.title).toBe("Read file");
    expect(toolCall.detail).toBe("apps/server/src/provider/acp/AcpRuntimeModel.ts");
    // A read must not carry changed files: the work log groups any entry that
    // has them as an edit, ahead of every other classification.
    expect(toolCall.data.files).toBeUndefined();
  });

  it("turns locations into changed files for edits only", () => {
    const edited = parseHermesToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "tc-edit",
      title: "patch (replace): apps/web/src/session-logic.ts",
      kind: "edit",
      locations: [
        { path: "apps/web/src/session-logic.ts" },
        { path: "apps/web/src/session-logic.ts" },
      ],
    });

    expect(edited.data.files).toEqual([{ path: "apps/web/src/session-logic.ts" }]);
    expect(edited.title).toBe("Changed files");
  });

  it("leaves an MCP or plugin call alone, because Hermes does send its rawInput", () => {
    // `_build_tool_start`: an unknown tool echoes its arguments as both content
    // and raw_input, which the shared path already reads.
    const toolCall = parseHermesToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "tc-mcp",
      title: "list_pull_requests",
      kind: "other",
      rawInput: { repository: "AndrewRocky/t3code", state: "open" },
      content: [textContent('{"repository": "AndrewRocky/t3code", "state": "open"}')],
    });

    expect(
      hermesToolCallAugment({
        toolCallId: "tc-mcp",
        kind: "other",
        status: "pending",
        title: "list_pull_requests",
        rawInput: { repository: "AndrewRocky/t3code" },
        rawOutput: undefined,
        locations: undefined,
        text: undefined,
        command: undefined,
      }),
    ).toBeUndefined();
    // An `other` kind keeps its own title as the summary without any help.
    expect(toolCall.title).toBe("list_pull_requests");
    expect(toolCall.data.rawInput).toEqual({
      repository: "AndrewRocky/t3code",
      state: "open",
    });
  });

  it("adds nothing when a tool call carries no title, locations or shell echo", () => {
    expect(
      hermesToolCallAugment({
        toolCallId: "tc-empty",
        kind: "execute",
        status: "inProgress",
        title: undefined,
        rawInput: undefined,
        rawOutput: undefined,
        locations: undefined,
        text: "some streamed output",
        command: undefined,
      }),
    ).toBeUndefined();
  });

  it("does not mistake ordinary output for a shell echo", () => {
    const toolCall = parseHermesToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "tc-echo",
      title: "process start: build",
      kind: "execute",
      content: [textContent("Process action: start\nSession: build")],
    });

    expect(toolCall.command).toBeUndefined();
    expect(toolCall.detail).toBe("process start: build");
  });
});
