import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import { type AcpToolCallState, parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import {
  HERMES_DELEGATION_DATA_KEY,
  hermesChildLabel,
  hermesDelegationMarkerOf,
  hermesTitleNamesDelegation,
  parseHermesDelegationHandle,
} from "./HermesSubagentProtocol.ts";
import { hermesToolCallAugment } from "./HermesToolCallAugment.ts";

/**
 * The handle below is what `hermes-agent@0.21.3` actually returns for a
 * background `delegate_task`, from `tools/delegate_tool_dispatch.py`
 * `_dispatched_payload` plus `_BACKGROUND_NOTES`. It reaches the client as a
 * plain string inside the completion's content block, because
 * `_format_delegate_result` only formats a payload carrying a `results` array
 * and returns `None` for a dispatch handle, so `_build_tool_complete_content`
 * falls through to the raw JSON.
 */
const DISPATCH_HANDLE = JSON.stringify({
  status: "dispatched",
  mode: "background",
  count: 2,
  delegation_id: "deleg_7c1a9e33",
  goals: ["Audit the auth middleware for timing leaks", "Benchmark the cold-start path"],
  note: "2 subagents are running in parallel in the background as 1 completion unit(s); each unit's results re-enter the conversation as their own new message when THAT unit finishes. Results are delivered only after you END YOUR TURN: do anything that does not depend on them, then stop with a one-line status.",
  subagent_ids: ["sa-0-1a2b3c4d", "sa-1-5e6f7a8b"],
  control_hint: "While a child runs you can orchestrate it live with this same tool",
  live_transcripts: [
    "/home/u/.hermes/cache/delegation/live/deleg_7c1a9e33/task-0.log",
    "/home/u/.hermes/cache/delegation/live/deleg_7c1a9e33/task-1.log",
  ],
});

function textContent(text: string): EffectAcpSchema.ToolCallContent {
  return { type: "content", content: { type: "text", text } } as EffectAcpSchema.ToolCallContent;
}

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

describe("hermesTitleNamesDelegation", () => {
  it("matches the tool name under both spellings it has shipped under", () => {
    expect(hermesTitleNamesDelegation("delegate_task: 2 tasks: audit | benchmark")).toBe(true);
    expect(hermesTitleNamesDelegation("delegate: audit the ACP adapter")).toBe(true);
  });

  it("is anchored, so a preview that merely mentions delegation does not match", () => {
    expect(hermesTitleNamesDelegation("terminal: git log --grep delegate_task:")).toBe(false);
    expect(hermesTitleNamesDelegation("web search: delegate: what does it mean")).toBe(false);
    expect(hermesTitleNamesDelegation(undefined)).toBe(false);
  });
});

describe("parseHermesDelegationHandle", () => {
  it("reads the child ids and goals out of a background dispatch handle", () => {
    const dispatch = parseHermesDelegationHandle(DISPATCH_HANDLE);

    expect(dispatch?.delegationId).toBe("deleg_7c1a9e33");
    expect(dispatch?.children).toEqual([
      {
        subagentId: "sa-0-1a2b3c4d",
        goal: "Audit the auth middleware for timing leaks",
        index: 0,
      },
      { subagentId: "sa-1-5e6f7a8b", goal: "Benchmark the cold-start path", index: 1 },
    ]);
  });

  it("pairs by position when one list is shorter than the other", () => {
    const dispatch = parseHermesDelegationHandle(
      JSON.stringify({
        status: "dispatched",
        mode: "background",
        count: 2,
        goals: ["only one goal"],
      }),
    );

    expect(dispatch?.delegationId).toBeUndefined();
    expect(dispatch?.children).toEqual([
      { subagentId: undefined, goal: "only one goal", index: 0 },
      { subagentId: undefined, goal: undefined, index: 1 },
    ]);
  });

  it("ignores everything that is not a background dispatch handle", () => {
    // A synchronous delegation returns real results and its tool call already
    // spans the children's lifetime, so the generic completion path is right
    // for it — matching here would settle the row on the wrong signal.
    expect(
      parseHermesDelegationHandle(JSON.stringify({ results: [{ task_index: 0 }] })),
    ).toBeUndefined();
    expect(
      parseHermesDelegationHandle(JSON.stringify({ status: "dispatched", mode: "inline" })),
    ).toBeUndefined();
    expect(parseHermesDelegationHandle("Delegating 2 tasks")).toBeUndefined();
    expect(parseHermesDelegationHandle("{not json")).toBeUndefined();
    expect(parseHermesDelegationHandle(undefined)).toBeUndefined();
  });
});

describe("delegation marker round trip", () => {
  it("marks the opening frame from the title alone", () => {
    const toolCall = parseHermesToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "delegate_task: 2 tasks: Audit the auth middleware | Benchmark the cold-start path",
      kind: "execute",
      content: [
        textContent(
          "Delegating 2 tasks\n\n1. Audit the auth middleware for timing leaks\n2. Benchmark the cold-start path",
        ),
      ],
    });

    expect(hermesDelegationMarkerOf(toolCall)).toEqual({ launch: true });
  });

  it("carries the dispatch handle through the terminal frame", () => {
    const toolCall = parseHermesToolCall({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      kind: "execute",
      status: "completed",
      content: [textContent(DISPATCH_HANDLE)],
    });

    const marker = hermesDelegationMarkerOf(toolCall);
    expect(marker?.launch).toBe(true);
    expect(marker?.dispatch?.delegationId).toBe("deleg_7c1a9e33");
    expect(marker?.dispatch?.children.map((child) => child.subagentId)).toEqual([
      "sa-0-1a2b3c4d",
      "sa-1-5e6f7a8b",
    ]);
  });

  it("leaves every other Hermes tool call unmarked", () => {
    for (const update of [
      { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "terminal: ls", kind: "execute" },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-3",
        title: "read_file: src/index.ts",
        kind: "read",
      },
      // Right title, wrong kind: a plugin tool cannot be promoted to an agent.
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-4",
        title: "delegate_task: not really",
        kind: "other",
      },
    ] as ReadonlyArray<EffectAcpSchema.SessionNotification["update"]>) {
      const toolCall = parseHermesToolCall(update);
      expect(toolCall.data[HERMES_DELEGATION_DATA_KEY]).toBeUndefined();
      expect(hermesDelegationMarkerOf(toolCall)).toBeUndefined();
    }
  });
});

describe("hermesChildLabel", () => {
  it("prefers the goal, then the child id, then the position", () => {
    expect(hermesChildLabel({ subagentId: "sa-0-x", goal: "Audit auth", index: 0 })).toBe(
      "Audit auth",
    );
    expect(hermesChildLabel({ subagentId: "sa-0-x", goal: undefined, index: 0 })).toBe("sa-0-x");
    expect(hermesChildLabel({ subagentId: undefined, goal: undefined, index: 2 })).toBe(
      "Subagent 3",
    );
  });
});
