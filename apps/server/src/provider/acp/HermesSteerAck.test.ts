import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import { makeHermesSteerAckFilter } from "./HermesSteerAck.ts";

const messageChunk = (text: string): EffectAcpSchema.SessionNotification => ({
  sessionId: "s1",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

const textOf = (notification: EffectAcpSchema.SessionNotification) =>
  notification.update.sessionUpdate === "agent_message_chunk" &&
  notification.update.content.type === "text"
    ? notification.update.content.text
    : undefined;

describe("makeHermesSteerAckFilter", () => {
  it("blanks the redirect receipt for an open steer and reports it", () => {
    const filter = makeHermesSteerAckFilter();
    const ticket = filter.expect();
    const out = filter.transformSessionUpdate(
      messageChunk("Redirected the active turn with your correction."),
    );
    expect(textOf(out)).toBe("");
    expect(ticket.close()).toBe("redirected");
  });

  it("recognises the queued receipt", () => {
    const filter = makeHermesSteerAckFilter();
    const ticket = filter.expect();
    expect(
      textOf(filter.transformSessionUpdate(messageChunk("Queued for the next turn. (2 queued)"))),
    ).toBe("");
    expect(ticket.close()).toBe("queued");
  });

  it("leaves identical assistant text alone when no steer is outstanding", () => {
    const filter = makeHermesSteerAckFilter();
    const text = "Redirected the active turn with your correction.";
    expect(textOf(filter.transformSessionUpdate(messageChunk(text)))).toBe(text);
    filter.expect().close();
    expect(textOf(filter.transformSessionUpdate(messageChunk(text)))).toBe(text);
  });

  it("passes ordinary text through while a steer is outstanding", () => {
    const filter = makeHermesSteerAckFilter();
    const ticket = filter.expect();
    expect(textOf(filter.transformSessionUpdate(messageChunk("Redirected the")))).toBe(
      "Redirected the",
    );
    expect(ticket.close()).toBe("none");
  });

  it("assigns receipts to steers in the order they were sent", () => {
    const filter = makeHermesSteerAckFilter();
    const first = filter.expect();
    const second = filter.expect();
    filter.transformSessionUpdate(messageChunk("Redirected the active turn with your correction."));
    filter.transformSessionUpdate(messageChunk("Queued for the next turn. (1 queued)"));
    expect(second.close()).toBe("queued");
    expect(first.close()).toBe("redirected");
  });
});
