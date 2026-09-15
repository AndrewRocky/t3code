import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import type { OrchestrationThreadActivity, ThreadId, TurnId } from "@t3tools/contracts";

import { projectActivityPayload } from "../../orchestration/ActivityPayloadProjection.ts";
import { makeAcpToolCallEvent } from "./AcpCoreRuntimeEvents.ts";
import { parseSessionUpdateEvent, type AcpToolCallState } from "./AcpRuntimeModel.ts";
import { hermesToolCallAugment } from "./HermesToolCallAugment.ts";

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

/**
 * End-to-end over the frames Hermes really sends: parse with the augmenter,
 * build the runtime event, then run the egress projection. What comes out is
 * exactly what a client receives.
 */
describe("Hermes tool calls end to end", () => {
  function projectedPayload(
    update: EffectAcpSchema.SessionNotification["update"],
  ): Record<string, unknown> {
    const toolCall = parseHermesToolCall(update);
    const event = makeAcpToolCallEvent({
      stamp: {
        eventId: "event-1",
        createdAt: "2026-09-10T00:00:00.000Z",
      } as unknown as Parameters<typeof makeAcpToolCallEvent>[0]["stamp"],
      provider: "hermes" as Parameters<typeof makeAcpToolCallEvent>[0]["provider"],
      threadId: "thread-1" as unknown as ThreadId,
      turnId: "turn-1" as unknown as TurnId,
      toolCall,
      rawPayload: { sessionId: "session-1", update },
    });
    const activity = {
      id: "activity-1",
      tone: "tool",
      kind: event.type === "item.completed" ? "tool.completed" : "tool.updated",
      summary: "Tool",
      payload: event.payload,
      turnId: null,
      createdAt: "2026-09-10T00:00:00.000Z",
    } as unknown as OrchestrationThreadActivity;
    return projectActivityPayload(activity).payload as Record<string, unknown>;
  }

  it("delivers the command and the whole result block for a failing shell command", () => {
    const block = [
      "terminal result",
      "- **output:** 12 passed, 1 failed",
      "- **exit_code:** 1",
      "- **exit_code_meaning:** general error",
      "- **hint:** rerun with --reporter=verbose",
    ].join("\n");

    projectedPayload({
      sessionUpdate: "tool_call",
      toolCallId: "tc-e2e",
      title: "terminal: pnpm test --filter web",
      kind: "execute",
      content: [textContent("$ pnpm test --filter web")],
    });
    const completed = projectedPayload({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-e2e",
      kind: "execute",
      status: "failed",
      content: [textContent(block)],
    });

    expect(completed.itemType).toBe("command_execution");
    expect(completed.status).toBe("failed");
    const data = completed.data as Record<string, unknown>;
    // The exit code, its meaning and the hint all reach the client now; before
    // this they were cut with the rest of the block at 84 characters.
    expect(data.rawOutput).toEqual({ content: "terminal result", text: block });
  });

  it("carries the workspace-search scope through the egress projection", () => {
    // `projectActivityPayload` rebuilds `data` from a whitelist — an unlisted
    // key never reaches a client — so the passthrough is as load-bearing as
    // the augmenter itself.
    const completed = projectedPayload({
      sessionUpdate: "tool_call",
      toolCallId: "tc-search-e2e",
      title: "search: direct",
      kind: "search",
      status: "completed",
      content: [textContent("File search results\nFound 50 files; showing 20.")],
    });

    expect(completed.itemType).toBe("web_search");
    expect((completed.data as Record<string, unknown>).searchScope).toBe("workspace");
  });

  it("does not scope Hermes' own web search, which arrives as kind fetch", () => {
    const completed = projectedPayload({
      sessionUpdate: "tool_call",
      toolCallId: "tc-websearch-e2e",
      title: "web search: effect-ts Layer composition",
      kind: "fetch",
      status: "completed",
      content: [textContent("web search results")],
    });

    expect(completed.itemType).toBe("web_search");
    expect((completed.data as Record<string, unknown>).searchScope).toBeUndefined();
  });

  it("leaves a Cursor- or Grok-shaped tool call byte-identical with and without the augmenter", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "tc-generic",
      title: "Terminal",
      kind: "execute",
      status: "pending",
      rawInput: { command: "bun run typecheck" },
      content: [textContent("running")],
    } as EffectAcpSchema.SessionNotification["update"];
    const notification = {
      sessionId: "session-1",
      update,
    } as EffectAcpSchema.SessionNotification;

    const withAugmenter = parseSessionUpdateEvent(notification, {
      toolCallAugment: hermesToolCallAugment,
    });
    const withoutAugmenter = parseSessionUpdateEvent(notification);

    expect(withAugmenter).toEqual(withoutAugmenter);
  });
});
