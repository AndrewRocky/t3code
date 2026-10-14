/**
 * HermesSteerAck — recognises Hermes' reply to a mid-turn `session/prompt`.
 *
 * A prompt that reaches Hermes while a turn is running never becomes a turn of
 * its own. `_claim_turn_or_queue` (`acp_adapter/server.py`) either redirects
 * the live turn with it or queues it behind that turn, announces which with
 * one `agent_message_chunk`, and answers the prompt with `end_turn`
 * straight away:
 *
 * - `Redirected the active turn with your correction.`
 * - `Queued for the next turn. (N queued)`
 *
 * That chunk is a receipt, not the agent talking, and T3 Code already shows
 * the user's message in the turn. Left alone it would land in the middle of
 * the assistant's answer. The adapter opens a ticket for every steer it
 * sends. While a ticket is open, the matching chunk is blanked before the
 * runtime parses it, and the ticket records which receipt it was. A blank
 * chunk opens no assistant item, so nothing renders. Matching is exact and
 * only happens while a steer is outstanding, so ordinary assistant text that
 * happens to read the same is never touched.
 *
 * @module provider/acp/HermesSteerAck
 */
import type * as EffectAcpSchema from "effect-acp/schema";

const HERMES_REDIRECT_ACK = "Redirected the active turn with your correction.";
const HERMES_QUEUED_ACK = /^Queued for the next turn\. \(\d+ queued\)$/;

/** What Hermes did with a steer. `none` means no receipt arrived for it. */
type HermesSteerOutcome = "redirected" | "queued" | "none";

interface HermesSteerTicket {
  /** Closes the ticket and reports the receipt it collected, if any. */
  readonly close: () => HermesSteerOutcome;
}

export interface HermesSteerAckFilter {
  /** Opens a ticket for a steer about to be sent. */
  readonly expect: () => HermesSteerTicket;
  /** Passed to the runtime as `transformSessionUpdate`. */
  readonly transformSessionUpdate: (
    notification: EffectAcpSchema.SessionNotification,
  ) => EffectAcpSchema.SessionNotification;
}

function classifyHermesSteerAck(
  update: EffectAcpSchema.SessionNotification["update"],
): Exclude<HermesSteerOutcome, "none"> | undefined {
  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
    return undefined;
  }
  const text = update.content.text.trim();
  if (text === HERMES_REDIRECT_ACK) return "redirected";
  if (HERMES_QUEUED_ACK.test(text)) return "queued";
  return undefined;
}

export function makeHermesSteerAckFilter(): HermesSteerAckFilter {
  // Oldest first. Hermes answers steers in the order they arrive.
  const open: Array<{ outcome: HermesSteerOutcome }> = [];

  return {
    expect: () => {
      const ticket = { outcome: "none" as HermesSteerOutcome };
      open.push(ticket);
      return {
        close: () => {
          const index = open.indexOf(ticket);
          if (index !== -1) open.splice(index, 1);
          return ticket.outcome;
        },
      };
    },
    transformSessionUpdate: (notification) => {
      const waiting = open.find((ticket) => ticket.outcome === "none");
      if (waiting === undefined) return notification;
      const update = notification.update;
      const outcome = classifyHermesSteerAck(update);
      if (
        outcome === undefined ||
        update.sessionUpdate !== "agent_message_chunk" ||
        update.content.type !== "text"
      ) {
        return notification;
      }
      waiting.outcome = outcome;
      return {
        ...notification,
        update: { ...update, content: { ...update.content, text: "" } },
      };
    },
  };
}
