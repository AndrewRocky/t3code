import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import {
  type HermesLedgerRow,
  hermesChildOutcome,
  makeHermesDelegationWatcher,
  makeHermesLedgerReader,
} from "./delegations.ts";
import { type HermesRuntimeHandle, HermesRuntimeRegistry } from "./runtime.ts";
import { HERMES_CHILD_META_KEY, parseHermesDelegationHandle } from "./subagents.ts";

const THREAD = "thread-1";
const SESSION = "hermes-session-1";

const dispatch = parseHermesDelegationHandle(
  JSON.stringify({
    status: "dispatched",
    mode: "background",
    count: 2,
    delegation_id: "deleg_1",
    goals: ["map the parser", "write tests"],
    subagent_ids: ["sa-a", "sa-b"],
  }),
)!;

const running = (results: ReadonlyArray<Record<string, unknown>> = []): HermesLedgerRow => ({
  delegationId: "deleg_1",
  state: "running",
  result: results.length === 0 ? undefined : { results, partial: true },
});

describe("hermesChildOutcome", () => {
  it("reports a child of a running unit once Hermes recorded it", () => {
    const row = running([{ task_index: 0, status: "completed", summary: "Parser mapped." }]);
    expect(hermesChildOutcome(row, 0, false)).toEqual({
      status: "completed",
      result: "Parser mapped.",
    });
    expect(hermesChildOutcome(row, 1, false)).toBeUndefined();
  });

  it("keeps an interrupted child apart from a failed one", () => {
    const row: HermesLedgerRow = {
      delegationId: "deleg_1",
      state: "error",
      result: {
        results: [
          { task_index: 0, status: "interrupted", summary: null, error: "Stopped by the user" },
          { task_index: 1, status: "error", summary: null, error: "Rate limited" },
        ],
      },
    };
    expect(hermesChildOutcome(row, 0, false)).toEqual({
      status: "interrupted",
      result: "Stopped by the user",
    });
    expect(hermesChildOutcome(row, 1, false)).toEqual({ status: "failed", result: "Rate limited" });
  });

  it("fails a child whose owner died before it reported", () => {
    const row: HermesLedgerRow = { delegationId: "deleg_1", state: "unknown", result: {} };
    expect(hermesChildOutcome(row, 1, false)?.status).toBe("failed");
    expect(hermesChildOutcome(row, 1, false)?.result).toContain("outcome is unknown");
  });

  it("reads a single child's own result shape", () => {
    const row: HermesLedgerRow = {
      delegationId: "deleg_1",
      state: "completed",
      result: { status: "completed", summary: "Done." },
    };
    expect(hermesChildOutcome(row, 0, true)).toEqual({ status: "completed", result: "Done." });
  });
});

/** Hermes' own DDL (`hermes_state_common.py`), so the reader is tested against the real shape. */
const ASYNC_DELEGATIONS_DDL = `CREATE TABLE async_delegations (
  delegation_id TEXT PRIMARY KEY, origin_session TEXT NOT NULL,
  origin_ui_session_id TEXT NOT NULL DEFAULT '', parent_session_id TEXT, state TEXT NOT NULL,
  dispatched_at REAL NOT NULL, completed_at REAL, updated_at REAL NOT NULL, event_json TEXT,
  result_json TEXT, delivery_state TEXT NOT NULL DEFAULT 'pending',
  delivery_attempts INTEGER NOT NULL DEFAULT 0, delivered_at REAL, owner_pid INTEGER,
  owner_started_at INTEGER, task_json TEXT, owner_execution_id TEXT, delivery_claim TEXT,
  delivery_claimed_at REAL, origin_session_id TEXT NOT NULL DEFAULT '')`;

it.layer(NodeServices.layer)("makeHermesLedgerReader", (it) => {
  it.effect("reads rows read-only and fails open on a missing database or table", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-ledger-" });
      const databasePath = path.join(directory, "state.db");
      const database = new NodeSqlite.DatabaseSync(databasePath);
      database.exec(ASYNC_DELEGATIONS_DDL);
      database
        .prepare(
          `INSERT INTO async_delegations
             (delegation_id, origin_session, state, dispatched_at, updated_at, result_json)
           VALUES (?, '', ?, 0, 0, ?)`,
        )
        .run("deleg_1", "running", JSON.stringify({ results: [{ task_index: 0 }], partial: true }));
      database.close();

      expect(yield* makeHermesLedgerReader(databasePath)(["deleg_1", "deleg_gone"])).toEqual([
        {
          delegationId: "deleg_1",
          state: "running",
          result: { results: [{ task_index: 0 }], partial: true },
        },
      ]);
      expect(
        yield* makeHermesLedgerReader(path.join(directory, "missing.db"))(["deleg_1"]),
      ).toBeUndefined();

      new NodeSqlite.DatabaseSync(path.join(directory, "empty.db")).close();
      expect(
        yield* makeHermesLedgerReader(path.join(directory, "empty.db"))(["deleg_1"]),
      ).toBeUndefined();
    }),
  );
});

type Finished = Parameters<NonNullable<HermesRuntimeHandle["extensions"]["finishSubagent"]>>[0];

const setup = Effect.fn(function* (input: {
  readonly promptOpen: boolean;
  readonly reads: ReadonlyArray<ReadonlyArray<HermesLedgerRow> | undefined>;
}) {
  const registry = new HermesRuntimeRegistry();
  const finished = yield* Queue.unbounded<Finished>();
  const injected = yield* Queue.unbounded<EffectAcpSchema.SessionNotification>();
  const handle = {
    threadId: THREAD,
    runtime: {},
    sessionId: () => SESSION,
    ownPromptOpen: () => input.promptOpen,
    inject: (notification: EffectAcpSchema.SessionNotification) =>
      Queue.offer(injected, notification).pipe(Effect.asVoid),
    controlPrompt: () => Effect.succeed(""),
    extensions: {
      finishSubagent: (notice: Finished) => Queue.offer(finished, notice).pipe(Effect.asVoid),
    },
  } as unknown as HermesRuntimeHandle;
  yield* registry.register(handle);
  const readsDone = yield* Queue.unbounded<ReadonlyArray<string>>();
  let readCount = 0;
  const watcher = yield* makeHermesDelegationWatcher({
    registry,
    readLedger: (ids) =>
      Effect.gen(function* () {
        const rows = input.reads[Math.min(readCount, input.reads.length - 1)];
        readCount += 1;
        yield* Queue.offer(readsDone, ids);
        return rows;
      }),
  });
  return { watcher, finished, injected, readsDone };
});

describe("makeHermesDelegationWatcher", () => {
  it.effect("finishes carried-over rows as Hermes records each child", () =>
    Effect.gen(function* () {
      const { watcher, finished, readsDone } = yield* setup({
        promptOpen: false,
        reads: [
          [running([{ task_index: 0, status: "completed", summary: "Parser mapped." }])],
          [
            {
              delegationId: "deleg_1",
              state: "completed",
              result: {
                results: [
                  { task_index: 0, status: "completed", summary: "Parser mapped." },
                  { task_index: 1, status: "completed", summary: "Tests written." },
                ],
              },
            },
          ],
        ],
      });
      expect(yield* watcher.pendingBackgroundWork(THREAD)).toBe(false);
      yield* watcher.track({
        threadId: THREAD,
        sessionId: SESSION,
        toolCallId: "call-1",
        dispatch,
      });
      expect(yield* watcher.pendingBackgroundWork(THREAD)).toBe(true);

      expect(yield* Queue.take(readsDone)).toEqual(["deleg_1"]);
      expect(yield* Queue.take(finished)).toEqual({
        sessionId: SESSION,
        childSessionId: "sa-a",
        status: "completed",
        result: "Parser mapped.",
      });
      expect(yield* watcher.pendingBackgroundWork(THREAD)).toBe(true);

      yield* TestClock.adjust("2 seconds");
      yield* Queue.take(readsDone);
      expect(yield* Queue.take(finished)).toMatchObject({
        childSessionId: "sa-b",
        result: "Tests written.",
      });
      expect(yield* watcher.pendingBackgroundWork(THREAD)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("completes a child inside T3's open turn with a child tool-call update", () =>
    Effect.gen(function* () {
      const { watcher, injected } = yield* setup({
        promptOpen: true,
        reads: [
          [
            running([
              { task_index: 1, status: "interrupted", summary: null, error: "Stopped by Hermes" },
            ]),
          ],
        ],
      });
      yield* watcher.track({
        threadId: THREAD,
        sessionId: SESSION,
        toolCallId: "call-1",
        dispatch,
      });
      const frame = yield* Queue.take(injected);
      expect(frame.update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "hermes-subagent:sa-b",
        status: "failed",
        _meta: { [HERMES_CHILD_META_KEY]: { nativeTaskId: "sa-b", outcome: "interrupted" } },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("does not pin the session while the ledger cannot be read", () =>
    Effect.gen(function* () {
      const { watcher, readsDone } = yield* setup({ promptOpen: false, reads: [undefined] });
      yield* watcher.track({
        threadId: THREAD,
        sessionId: SESSION,
        toolCallId: "call-1",
        dispatch,
      });
      yield* Queue.take(readsDone);
      expect(yield* watcher.pendingBackgroundWork(THREAD)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
