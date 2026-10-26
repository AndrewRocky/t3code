import { assert, it } from "@effect/vitest";
import {
  type AcpToolCallState,
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@t3tools/provider-acp/server/runtimeModel";
import { describe } from "vite-plus/test";

import { extractHermesSubagentUpdate, parseHermesDelegationHandle } from "./subagents.ts";
import { normalizeHermesToolCall } from "./toolCalls.ts";

function toolState(update: Record<string, unknown>): AcpToolCallState {
  const parsed = parseSessionUpdateEvent({
    sessionId: "session-1",
    update: update as never,
  });
  const event = parsed.events.find((candidate) => candidate._tag === "ToolCallUpdated");
  assert.isDefined(event);
  if (event?._tag !== "ToolCallUpdated") throw new Error("not a tool call");
  return event.toolCall;
}

const text = (value: string) => [{ type: "content", content: { type: "text", text: value } }];

function lifecycle(...updates: ReadonlyArray<Record<string, unknown>>): AcpToolCallState {
  let state: AcpToolCallState | undefined;
  for (const update of updates) {
    state = normalizeHermesToolCall(mergeToolCallState(state, toolState(update)));
  }
  if (state === undefined) throw new Error("no updates");
  return state;
}

describe("normalizeHermesToolCall", () => {
  it("recovers the command from the start echo and the exit code from the result", () => {
    const state = lifecycle(
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "terminal: pnpm test --filter web",
        kind: "execute",
        status: "in_progress",
        content: text("$ pnpm test --filter web --reporter=dot"),
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        kind: "execute",
        status: "failed",
        content: text(
          "terminal result\n- **output:** 2 failed\n  at foo.test.ts:3\n- **exit_code:** 1",
        ),
      },
    );
    assert.equal(state.command, "pnpm test --filter web --reporter=dot");
    assert.deepStrictEqual(state.data.rawOutput, {
      exit_code: 1,
      output: "2 failed\n  at foo.test.ts:3",
    });
  });

  it("falls back to the clipped title when the start block has no echo", () => {
    const state = lifecycle({
      sessionUpdate: "tool_call",
      toolCallId: "tc-2",
      title: "terminal: ls -la",
      kind: "execute",
      status: "in_progress",
    });
    assert.equal(state.command, "ls -la");
  });

  it("leaves a non-terminal tool's command alone", () => {
    const state = lifecycle({
      sessionUpdate: "tool_call",
      toolCallId: "tc-3",
      title: "read_file: src/a.ts",
      kind: "read",
      status: "in_progress",
      locations: [{ path: "src/a.ts" }],
    });
    assert.isUndefined(state.command);
  });

  it("restores the editor MCP server name the gateway rewrote", () => {
    const state = lifecycle({
      sessionUpdate: "tool_call",
      toolCallId: "tc-4",
      title: "mcp__editor_t3_code_1a2b3c4d__preview_snapshot: localhost:5173",
      kind: "other",
      status: "in_progress",
      rawInput: { url: "localhost:5173" },
    });
    assert.equal(state.data.title, "mcp__t3_code__preview_snapshot: localhost:5173");
  });

  it("summarizes a background dispatch handle instead of showing its JSON", () => {
    const handle = JSON.stringify({
      status: "dispatched",
      mode: "background",
      count: 1,
      delegation_id: "deleg_1",
      goals: ["audit the adapter", "write docs"],
      subagent_ids: ["sa-1-aa"],
      refused: [{ task_index: 1, status: "error", error: "no route" }],
    });
    const state = lifecycle(
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-5",
        title: "delegate_task: 2 tasks",
        kind: "execute",
        status: "in_progress",
        content: text("Delegating 2 tasks"),
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-5",
        kind: "execute",
        status: "completed",
        content: text(handle),
      },
    );
    assert.equal(state.kind, "other");
    assert.deepStrictEqual(
      state.data.content,
      text("Started 1 subagent in the background.\nTask 2 was not started: no route"),
    );
  });
});

describe("parseHermesDelegationHandle", () => {
  it("pairs subagent ids with the goals of the tasks that started", () => {
    const dispatch = parseHermesDelegationHandle(
      JSON.stringify({
        status: "dispatched",
        mode: "background",
        count: 2,
        delegation_id: "deleg_x",
        goals: ["a", "refused one", "c"],
        subagent_ids: ["sa-0-a", "sa-2-c"],
        refused: [{ task_index: 1, error: "no route" }],
        units: [{ delegation_id: "deleg_y", group: "g", task_indexes: [2] }],
      }),
    );
    assert.deepStrictEqual(
      dispatch?.children.map((child) => [child.subagentId, child.goal, child.taskIndex]),
      [
        ["sa-0-a", "a", 0],
        ["sa-2-c", "c", 2],
      ],
    );
    assert.deepStrictEqual(dispatch?.refused, [{ taskIndex: 1, error: "no route" }]);
    assert.deepStrictEqual(dispatch?.units, [{ delegationId: "deleg_y", taskIndexes: [2] }]);
  });

  it("ignores synchronous results and other tools' JSON", () => {
    assert.isUndefined(parseHermesDelegationHandle(JSON.stringify({ results: [] })));
    assert.isUndefined(parseHermesDelegationHandle("not json"));
  });
});

describe("extractHermesSubagentUpdate", () => {
  const child = (status: string, extra: Record<string, unknown> = {}) =>
    toolState({
      sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
      toolCallId: "hermes-subagent:sa-0-a",
      title: "Subagent",
      kind: "other",
      status,
      _meta: {
        t3HermesSubagent: {
          nativeTaskId: "sa-0-a",
          delegationId: "deleg_x",
          taskIndex: 0,
          goal: "audit the adapter",
          ...extra,
        },
      },
      ...(status === "in_progress" ? {} : { content: text("Found two issues.") }),
    });

  it("maps synthetic child tool calls onto subagent rows", () => {
    assert.deepStrictEqual(extractHermesSubagentUpdate(child("in_progress")), {
      nativeTaskId: "sa-0-a",
      prompt: "audit the adapter",
      title: "audit the adapter",
      model: null,
      status: "running",
      childSessionId: null,
      result: null,
      suppressNormalTool: true,
    });
    assert.equal(extractHermesSubagentUpdate(child("completed"))?.result, "Found two issues.");
    assert.equal(
      extractHermesSubagentUpdate(child("failed", { outcome: "interrupted" }))?.status,
      "interrupted",
    );
  });

  it("ignores Hermes' own tool calls", () => {
    assert.isUndefined(
      extractHermesSubagentUpdate(
        toolState({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "delegate_task: 2 tasks",
          kind: "execute",
          status: "in_progress",
        }),
      ),
    );
  });
});
