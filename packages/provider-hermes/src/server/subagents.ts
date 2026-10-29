import type {
  AcpAdapterV2Flavor,
  AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

// ACP drops Hermes' `subagent.*` events. A background `delegate_task` returns a
// dispatch handle naming its children; the runtime turns it into one synthetic
// tool call per child, and the ledger watcher completes them later.

/** Matched loosely: the tool was `delegate` before it was `delegate_task`. */
const DELEGATION_TITLE_PATTERN = /^\s*delegate(?:_task)?\s*:/iu;

const MAX_TEXT_CHARS = 400;
const MAX_CHILDREN = 64;

/** Prefix of the synthetic per-child tool call ids the runtime decorator injects. */
const HERMES_CHILD_TOOL_CALL_PREFIX = "hermes-subagent:";

/** `_meta` key on a synthetic child tool call; nothing outside this package reads it. */
export const HERMES_CHILD_META_KEY = "t3HermesSubagent";

export interface HermesDelegationChild {
  /** `sa-<index>-<hex>`; absent when Hermes gave the child no id. */
  readonly subagentId: string | undefined;
  readonly goal: string | undefined;
  /** Position in the call's `tasks` array, the key ledger results use. */
  readonly taskIndex: number;
}

export interface HermesDelegationDispatch {
  /** `deleg_<hex>`, the `async_delegations` primary key of the first unit. */
  readonly delegationId: string | undefined;
  /** Further units when `delegation.independent_completions` splits the call. */
  readonly units: ReadonlyArray<{
    readonly delegationId: string;
    readonly taskIndexes: ReadonlyArray<number>;
  }>;
  /** Children Hermes started, in task order. */
  readonly children: ReadonlyArray<HermesDelegationChild>;
  /** Tasks the delegation backend refused; no child exists for them. */
  readonly refused: ReadonlyArray<{
    readonly taskIndex: number;
    readonly error: string | undefined;
  }>;
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

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function hermesTitleNamesDelegation(title: string | undefined): boolean {
  return title !== undefined && DELEGATION_TITLE_PATTERN.test(title);
}

/**
 * The background handle (`{"status": "dispatched", "mode": "background"}`), else
 * `undefined`. `subagent_ids` lists only started children in task order, so
 * refused task indexes are skipped when pairing them with `goals`.
 */
export function parseHermesDelegationHandle(
  text: string | undefined,
): HermesDelegationDispatch | undefined {
  if (text === undefined) return undefined;
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.status !== "dispatched" || parsed.mode !== "background") {
    return undefined;
  }

  const goals = Array.isArray(parsed.goals) ? parsed.goals : [];
  const subagentIds = Array.isArray(parsed.subagent_ids) ? parsed.subagent_ids : [];
  const refused = (Array.isArray(parsed.refused) ? parsed.refused : []).flatMap((entry) => {
    const taskIndex = isRecord(entry) ? integer(entry.task_index) : undefined;
    return taskIndex === undefined || !isRecord(entry)
      ? []
      : [{ taskIndex, error: boundedText(entry.error) }];
  });
  const refusedIndexes = new Set(refused.map((entry) => entry.taskIndex));
  const declaredCount = integer(parsed.count);
  const startedIndexes: number[] = [];
  for (let index = 0; index < goals.length; index += 1) {
    if (!refusedIndexes.has(index)) startedIndexes.push(index);
  }
  const childCount = Math.min(
    MAX_CHILDREN,
    declaredCount ?? Math.max(startedIndexes.length, subagentIds.length),
  );
  const children: HermesDelegationChild[] = [];
  for (let position = 0; position < childCount; position += 1) {
    const taskIndex = startedIndexes[position] ?? position;
    children.push({
      subagentId: boundedId(subagentIds[position]),
      goal: boundedText(goals[taskIndex]),
      taskIndex,
    });
  }
  const units = (Array.isArray(parsed.units) ? parsed.units : []).flatMap((unit) => {
    if (!isRecord(unit)) return [];
    const delegationId = boundedId(unit.delegation_id);
    const taskIndexes = (Array.isArray(unit.task_indexes) ? unit.task_indexes : []).flatMap(
      (value) => {
        const index = integer(value);
        return index === undefined ? [] : [index];
      },
    );
    return delegationId === undefined ? [] : [{ delegationId, taskIndexes }];
  });
  return { delegationId: boundedId(parsed.delegation_id), units, children, refused };
}

/** The ledger row (delegation id) that will report a child's result. */
export function hermesDelegationIdForChild(
  dispatch: HermesDelegationDispatch,
  child: HermesDelegationChild,
): string | undefined {
  return (
    dispatch.units.find((unit) => unit.taskIndexes.includes(child.taskIndex))?.delegationId ??
    dispatch.delegationId
  );
}

/** Stable T3 identity for a child: Hermes' own id when it has one. */
export function hermesChildNativeTaskId(
  dispatch: HermesDelegationDispatch,
  child: HermesDelegationChild,
): string {
  return (
    child.subagentId ?? `${dispatch.delegationId ?? "delegation"}:task-${String(child.taskIndex)}`
  );
}

export function hermesChildLabel(child: HermesDelegationChild): string {
  return child.goal ?? child.subagentId ?? `Subagent ${String(child.taskIndex + 1)}`;
}

export interface HermesChildToolMeta {
  readonly nativeTaskId: string;
  readonly delegationId: string | undefined;
  readonly taskIndex: number;
  readonly goal: string;
  /** Hermes' own terminal status, kept so `interrupted` is not reported as a failure. */
  readonly outcome?: "interrupted" | undefined;
}

export function hermesChildToolCallId(nativeTaskId: string): string {
  return `${HERMES_CHILD_TOOL_CALL_PREFIX}${nativeTaskId}`;
}

function childMeta(toolCall: AcpToolCallState): HermesChildToolMeta | undefined {
  if (!toolCall.toolCallId.startsWith(HERMES_CHILD_TOOL_CALL_PREFIX)) return undefined;
  const meta = isRecord(toolCall.data.meta) ? toolCall.data.meta[HERMES_CHILD_META_KEY] : undefined;
  if (!isRecord(meta)) return undefined;
  const nativeTaskId = boundedId(meta.nativeTaskId);
  const goal = boundedText(meta.goal);
  const taskIndex = integer(meta.taskIndex);
  if (nativeTaskId === undefined || goal === undefined || taskIndex === undefined) return undefined;
  return {
    nativeTaskId,
    delegationId: boundedId(meta.delegationId),
    taskIndex,
    goal,
    ...(meta.outcome === "interrupted" ? { outcome: "interrupted" as const } : {}),
  };
}

function toolOutputText(toolCall: AcpToolCallState): string | undefined {
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((entry) => {
    const text = isRecord(entry) && isRecord(entry.content) ? entry.content.text : undefined;
    return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * Only synthetic child tool calls are subagents. Their rows stay running
 * across the parent's turn end until the ledger reports a result, so the
 * thread shows Waiting for as long as Hermes' children really run.
 */
export const extractHermesSubagentUpdate: NonNullable<
  AcpAdapterV2Flavor["extractSubagentUpdate"]
> = (toolCall): AcpAdapterV2SubagentUpdate | undefined => {
  const meta = childMeta(toolCall);
  if (meta === undefined) return undefined;
  const status: AcpAdapterV2SubagentUpdate["status"] =
    toolCall.status === "completed"
      ? "completed"
      : toolCall.status === "failed"
        ? meta.outcome === "interrupted"
          ? "interrupted"
          : "failed"
        : "running";
  const result = status === "running" ? null : (toolOutputText(toolCall) ?? null);
  return {
    nativeTaskId: meta.nativeTaskId,
    prompt: meta.goal,
    title: meta.goal.length <= 80 ? meta.goal : `${meta.goal.slice(0, 79).trimEnd()}…`,
    model: null,
    status,
    childSessionId: null,
    result,
    suppressNormalTool: true,
  };
};
