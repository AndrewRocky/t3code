/**
 * HermesSubagentProtocol — recognise Hermes' `delegate_task` fan-out in the
 * ordinary ACP tool-call stream, and read what it says about its children.
 *
 * Hermes has no subagent channel over ACP. `acp_adapter/events.py` drops every
 * internal event except `tool.started`, so the `subagent.start` / `.tool` /
 * `.complete` stream — which already carries `subagent_id`, `parent_id`,
 * `depth`, `model`, token counts and per-child summaries, and which the
 * upstream gateway and TUI both consume — never reaches a client. A delegation
 * is therefore one ordinary `tool_call` of kind `execute`, and without the
 * inference in this module it renders as a generic "Ran command" row.
 *
 * Two carriers are available, and this module reads both:
 *
 * 1. **The title.** `build_tool_title` emits `f"{tool_name}: {preview}"`, so a
 *    delegation opens as `delegate_task: 2 tasks: …`. Matched loosely because
 *    upstream has renamed tools before (`search` → `search_files`, and the
 *    tool was `delegate` before it was `delegate_task`).
 * 2. **The dispatch handle.** A top-level delegation always runs in the
 *    background (`run_agent.py` `_dispatch_delegate_task`), so the tool result
 *    is a JSON handle rather than child results. `_format_delegate_result`
 *    only formats a payload with a `results` array, so for a background
 *    dispatch it returns `None` and `_build_tool_complete_content` falls
 *    through to the raw JSON. That handle carries the real per-child
 *    `subagent_ids`, their `goals` and a stable `delegation_id` — the only
 *    per-child identity Hermes puts on the wire today.
 *
 * Kept in its own module, and keyed off a marker the Hermes tool-call
 * augmenter stamps rather than off the title directly, because by the time an
 * adapter sees an {@link AcpToolCallState} the agent's own title has already
 * been replaced by a generic presentation label. See
 * {@link HermesToolCallAugment}.
 *
 * @module provider/acp/HermesSubagentProtocol
 */

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

/**
 * `data` key the Hermes augmenter stamps on a delegation tool call.
 *
 * Server-side only: `ActivityPayloadProjection` forwards an explicit list of
 * `data` keys and drops everything else, so this never reaches a client. The
 * adapter reads it to decide whether a tool call is a delegation.
 */
export const HERMES_DELEGATION_DATA_KEY = "hermesDelegation";

/**
 * Hermes' delegation tool, as it appears at the head of an ACP tool-call title.
 *
 * Deliberately tolerant of the name: `agent/display.py` builds the title from
 * the registered tool name, which has changed across releases. Anchored and
 * case-insensitive so an unrelated tool whose *preview* happens to mention
 * delegation cannot match.
 */
const DELEGATION_TITLE_PATTERN = /^\s*delegate(?:_task)?\s*:/iu;

/** Bound on any single string this module lifts out of agent output. */
const MAX_TEXT_CHARS = 400;

/** Bound on how many children one handle may describe. */
const MAX_CHILDREN = 64;

/**
 * What the background dispatch handle told us about one `delegate_task` call.
 *
 * Every field is optional on the wire — the handle's shape is upstream's
 * model-facing contract, not a protocol schema — so a partial parse is
 * normal and yields whatever was present.
 */
export interface HermesDelegationDispatch {
  /** `deleg_<hex>`; stable, and also the live-transcript directory name. */
  readonly delegationId: string | undefined;
  /** Children in this call, in task order. */
  readonly children: ReadonlyArray<HermesDelegationChild>;
}

export interface HermesDelegationChild {
  /** `sa-<index>-<hex>`, Hermes' own child id. Absent on older releases. */
  readonly subagentId: string | undefined;
  /** The task text the model wrote for this child. */
  readonly goal: string | undefined;
  /** Position in the call's `tasks` array. */
  readonly index: number;
}

/** The marker the augmenter stamps, and the adapter reads back. */
export interface HermesDelegationMarker {
  /** Always true; present so the marker is a record, not a bare boolean. */
  readonly launch: true;
  /** Only on the terminal frame, and only when the handle parsed. */
  readonly dispatch?: HermesDelegationDispatch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= MAX_TEXT_CHARS ? trimmed : `${trimmed.slice(0, MAX_TEXT_CHARS)}…`;
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
}

/** Whether an agent title names the delegation tool. */
export function hermesTitleNamesDelegation(title: string | undefined): boolean {
  return title !== undefined && DELEGATION_TITLE_PATTERN.test(title);
}

/**
 * Parse a background dispatch handle out of a delegation's completion text.
 *
 * Returns `undefined` for anything that is not recognisably one, so this is
 * safe to try on any tool call's output: the discriminator is upstream's own
 * `{"status": "dispatched", "mode": "background", …}` payload
 * (`tools/delegate_tool_dispatch.py` `_dispatched_payload`), which no other
 * Hermes tool produces.
 *
 * A *synchronous* delegation — a nested orchestrator subagent, or a top-level
 * one once upstream declares ACP a stateless channel — returns real results
 * instead and is deliberately not matched here: its children are already
 * summarised in the tool output, and its tool call spans the children's whole
 * lifetime, so the generic completion path is correct for it.
 */
export function parseHermesDelegationHandle(
  text: string | undefined,
): HermesDelegationDispatch | undefined {
  if (text === undefined) return undefined;
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(start === 0 ? text : text.slice(start));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.status !== "dispatched" || parsed.mode !== "background") return undefined;

  const goals = Array.isArray(parsed.goals) ? parsed.goals : [];
  const subagentIds = Array.isArray(parsed.subagent_ids) ? parsed.subagent_ids : [];
  const declaredCount = typeof parsed.count === "number" ? parsed.count : undefined;
  const childCount = Math.min(
    MAX_CHILDREN,
    Math.max(goals.length, subagentIds.length, declaredCount ?? 0),
  );
  const children: Array<HermesDelegationChild> = [];
  for (let index = 0; index < childCount; index += 1) {
    children.push({
      subagentId: boundedId(subagentIds[index]),
      goal: boundedText(goals[index]),
      index,
    });
  }
  return {
    delegationId: boundedId(parsed.delegation_id),
    children,
  };
}

/**
 * Build the marker for one tool-call frame, or `undefined` when the frame is
 * not a delegation.
 *
 * Both carriers are checked independently, because they arrive on different
 * frames: Hermes titles the `tool_call` but sends no title on the
 * `tool_call_update`, and the handle only exists on the terminal frame.
 */
export function hermesDelegationMarkerFor(input: {
  readonly title: string | undefined;
  readonly text: string | undefined;
}): HermesDelegationMarker | undefined {
  const dispatch = parseHermesDelegationHandle(input.text);
  if (dispatch !== undefined) {
    return { launch: true, dispatch };
  }
  return hermesTitleNamesDelegation(input.title) ? { launch: true } : undefined;
}

/**
 * Read back the marker an earlier frame stamped.
 *
 * `mergeToolCallState` merges `data` shallowly onto the previous state, so a
 * marker set on the opening frame survives onto later frames of the same tool
 * call — but only while the shared runtime still tracks that call, which it
 * stops doing the moment the call completes. The adapter's own sticky map is
 * what covers everything after that.
 */
export function hermesDelegationMarkerOf(
  toolCall: AcpToolCallState,
): HermesDelegationMarker | undefined {
  const marker = toolCall.data[HERMES_DELEGATION_DATA_KEY];
  if (!isRecord(marker) || marker.launch !== true) return undefined;
  const dispatch = marker.dispatch;
  if (!isRecord(dispatch)) return { launch: true };
  const children = Array.isArray(dispatch.children) ? dispatch.children : [];
  return {
    launch: true,
    dispatch: {
      delegationId: boundedId(dispatch.delegationId),
      children: children.flatMap((child, index) =>
        isRecord(child)
          ? [
              {
                subagentId: boundedId(child.subagentId),
                goal: boundedText(child.goal),
                index: typeof child.index === "number" ? child.index : index,
              },
            ]
          : [],
      ),
    },
  };
}

/**
 * A short, human label for one child.
 *
 * `TaskProgressPayload.description` is the one required non-id field in the
 * task family, so every caller needs a non-empty fallback.
 */
export function hermesChildLabel(child: HermesDelegationChild): string {
  return child.goal ?? child.subagentId ?? `Subagent ${child.index + 1}`;
}
