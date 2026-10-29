import * as NodeSqlite from "node:sqlite";

import type * as EffectAcpSchema from "effect-acp/compat";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import type { HermesDispatchedDelegation, HermesRuntimeRegistry } from "./runtime.ts";
import {
  HERMES_CHILD_META_KEY,
  hermesChildLabel,
  hermesChildNativeTaskId,
  hermesChildToolCallId,
  hermesDelegationIdForChild,
} from "./subagents.ts";

// Background children report only through `async_delegations` in `state.db`: a
// unit stays `running` with finished children in `result_json`, then takes its
// status (`unknown` when its owner died). Read-only; anything unexpected is skipped.

const MAX_RESULT_CHARS = 2_000;
const DEFAULT_POLL_INTERVAL: Duration.Input = "2 seconds";

/** `running` on disk; `stalling` and `finalizing` are in-memory states a row may carry later. */
const LIVE_STATES = new Set(["running", "stalling", "finalizing"]);
const SUCCESS_STATUSES = new Set(["completed", "success"]);
const STOPPED_STATUSES = new Set(["interrupted", "cancelled"]);

const UNKNOWN_OUTCOME = "Hermes stopped before this subagent finished, so its outcome is unknown.";

export interface HermesLedgerRow {
  readonly delegationId: string;
  readonly state: string;
  readonly result: unknown;
}

/** The rows for these ids, or `undefined` when the ledger cannot be read. */
export type HermesLedgerReader = (
  delegationIds: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<HermesLedgerRow> | undefined>;

export interface HermesChildOutcome {
  readonly status: "completed" | "failed" | "interrupted";
  readonly result: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= MAX_RESULT_CHARS ? trimmed : `${trimmed.slice(0, MAX_RESULT_CHARS)}…`;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function outcomeOf(status: unknown, summary: unknown, error: unknown): HermesChildOutcome {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (SUCCESS_STATUSES.has(normalized)) {
    return { status: "completed", result: text(summary) ?? null };
  }
  if (STOPPED_STATUSES.has(normalized)) {
    return { status: "interrupted", result: text(summary) ?? text(error) ?? null };
  }
  if (normalized === "unknown") {
    return { status: "failed", result: text(error) ?? UNKNOWN_OUTCOME };
  }
  return { status: "failed", result: text(error) ?? text(summary) ?? null };
}

/**
 * A child's result once Hermes recorded one. Background units always write
 * per-task `results`; a single-task row may carry the child's own result
 * instead, so that shape is accepted when the unit has only this child.
 */
export function hermesChildOutcome(
  row: HermesLedgerRow,
  taskIndex: number,
  onlyChild: boolean,
): HermesChildOutcome | undefined {
  const result = isRecord(row.result) ? row.result : {};
  const entries = Array.isArray(result.results) ? result.results.filter(isRecord) : [];
  const entry = entries.find((candidate) => candidate.task_index === taskIndex);
  if (entry !== undefined) return outcomeOf(entry.status, entry.summary, entry.error);
  if (LIVE_STATES.has(row.state)) return undefined;
  if (onlyChild && entries.length === 0 && typeof result.status === "string") {
    return outcomeOf(result.status, result.summary, result.error);
  }
  return outcomeOf(row.state, undefined, result.error);
}

export const makeHermesLedgerReader =
  (databasePath: string): HermesLedgerReader =>
  (delegationIds) =>
    delegationIds.length === 0
      ? Effect.succeed([])
      : Effect.try(() => {
          const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
          try {
            database.exec("PRAGMA busy_timeout = 100");
            const placeholders = delegationIds.map(() => "?").join(", ");
            const rows = database
              .prepare(
                `SELECT delegation_id, state, result_json FROM async_delegations
                 WHERE delegation_id IN (${placeholders})`,
              )
              .all(...delegationIds);
            return rows.flatMap((row): HermesLedgerRow[] =>
              typeof row.delegation_id === "string" && typeof row.state === "string"
                ? [
                    {
                      delegationId: row.delegation_id,
                      state: row.state,
                      result: parseJson(row.result_json),
                    },
                  ]
                : [],
            );
          } finally {
            database.close();
          }
        }).pipe(Effect.orElseSucceed(() => undefined));

interface TrackedChild {
  readonly threadId: string;
  readonly sessionId: string;
  readonly nativeTaskId: string;
  readonly delegationId: string;
  readonly taskIndex: number;
  readonly goal: string;
  readonly onlyChild: boolean;
}

export interface HermesDelegationWatcher {
  readonly track: (delegation: HermesDispatchedDelegation) => Effect.Effect<void>;
  /** True while a child Hermes started for this thread has not reported. */
  readonly pendingBackgroundWork: (threadId: string) => Effect.Effect<boolean>;
}

/**
 * Polls the ledger only while children are open. A result reaches the adapter
 * as a child tool-call update while T3's own prompt is open, since the
 * adapter matches a running turn's subagents by native task id; otherwise it
 * finishes the carried-over row through `finishSubagent`.
 */
export const makeHermesDelegationWatcher = Effect.fn("HermesDelegationWatcher.make")(
  function* (input: {
    readonly registry: HermesRuntimeRegistry;
    readonly readLedger: HermesLedgerReader;
    readonly pollInterval?: Duration.Input;
  }) {
    const tracked = new Map<string, TrackedChild>();
    const wake = yield* Queue.dropping<void>(1);
    let ledgerReadable = true;

    const keyOf = (child: Pick<TrackedChild, "threadId" | "nativeTaskId">) =>
      `${child.threadId}\u0000${child.nativeTaskId}`;

    const deliver = (child: TrackedChild, outcome: HermesChildOutcome) => {
      const handle = input.registry.get(child.threadId);
      // A replaced Hermes session never had these rows.
      if (handle === undefined || handle.sessionId() !== child.sessionId) return Effect.void;
      if (handle.ownPromptOpen()) {
        return handle.inject({
          sessionId: child.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: hermesChildToolCallId(child.nativeTaskId),
            status: outcome.status === "completed" ? "completed" : "failed",
            ...(outcome.result === null
              ? {}
              : {
                  content: [{ type: "content", content: { type: "text", text: outcome.result } }],
                }),
            _meta: {
              [HERMES_CHILD_META_KEY]: {
                nativeTaskId: child.nativeTaskId,
                delegationId: child.delegationId,
                taskIndex: child.taskIndex,
                goal: child.goal,
                ...(outcome.status === "interrupted" ? { outcome: "interrupted" } : {}),
              },
            },
          },
        } satisfies EffectAcpSchema.SessionNotification);
      }
      const finishSubagent = handle.extensions.finishSubagent;
      return finishSubagent === undefined
        ? Effect.void
        : finishSubagent({
            sessionId: child.sessionId,
            childSessionId: child.nativeTaskId,
            status: outcome.status === "interrupted" ? "cancelled" : outcome.status,
            result: outcome.result,
          });
    };

    const poll = Effect.gen(function* () {
      const children = [...tracked.values()];
      const rows = yield* input.readLedger([
        ...new Set(children.map((child) => child.delegationId)),
      ]);
      if (rows === undefined) {
        if (ledgerReadable) {
          yield* Effect.logWarning(
            "Could not read Hermes' delegation ledger; background subagent rows will not complete.",
          );
        }
        ledgerReadable = false;
        return;
      }
      ledgerReadable = true;
      const byId = new Map(rows.map((row) => [row.delegationId, row]));
      for (const child of children) {
        const row = byId.get(child.delegationId);
        const outcome =
          row === undefined ? undefined : hermesChildOutcome(row, child.taskIndex, child.onlyChild);
        if (outcome === undefined) continue;
        tracked.delete(keyOf(child));
        yield* deliver(child, outcome);
      }
    });

    yield* Effect.gen(function* () {
      if (tracked.size === 0) yield* Queue.take(wake);
      yield* poll;
      yield* Effect.sleep(input.pollInterval ?? DEFAULT_POLL_INTERVAL);
    }).pipe(Effect.forever, Effect.forkScoped);

    const watcher: HermesDelegationWatcher = {
      track: ({ threadId, sessionId, dispatch }) =>
        Effect.suspend(() => {
          if (threadId === undefined) return Effect.void;
          const units = dispatch.children.map((child) =>
            hermesDelegationIdForChild(dispatch, child),
          );
          for (const [position, child] of dispatch.children.entries()) {
            const delegationId = units[position];
            if (delegationId === undefined) continue;
            const entry: TrackedChild = {
              threadId,
              sessionId,
              nativeTaskId: hermesChildNativeTaskId(dispatch, child),
              delegationId,
              taskIndex: child.taskIndex,
              goal: hermesChildLabel(child),
              onlyChild: units.filter((unit) => unit === delegationId).length === 1,
            };
            tracked.set(keyOf(entry), entry);
          }
          return Queue.offer(wake, undefined).pipe(Effect.asVoid);
        }),
      pendingBackgroundWork: (threadId) =>
        Effect.sync(
          () =>
            ledgerReadable && [...tracked.values()].some((child) => child.threadId === threadId),
        ),
    };
    return watcher;
  },
);
