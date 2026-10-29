import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { hermesUsageReader } from "./usage.ts";

// The columns T3 reads from Hermes' `session_model_usage` (hermes_state_common.py).
const SCHEMA = `CREATE TABLE session_model_usage (
  session_id TEXT NOT NULL, model TEXT NOT NULL,
  billing_provider TEXT NOT NULL DEFAULT '', billing_base_url TEXT NOT NULL DEFAULT '',
  billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
  api_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0,
  cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL)`;

const WINDOW_START_MS = 1_790_000_000_000;
const IN_WINDOW_S = WINDOW_START_MS / 1000 + 3600;

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

const scan = (instances: ReadonlyArray<{ readonly id: string; readonly home: string }>) => {
  if (hermesUsageReader.kind !== "scan") throw new Error("Expected a Hermes scan reader");
  return hermesUsageReader.scan({
    instances: instances.map(({ id, home }) => ({
      instanceId: ProviderInstanceId.make(id),
      config: undefined,
      environment: { HERMES_HOME: home },
      configured: true,
    })),
    settings: DEFAULT_SERVER_SETTINGS,
    windowStartMs: WINDOW_START_MS,
    retentionCutoffMs: 0,
    awaitRefresh: true,
  });
};

describe("hermesUsageReader", () => {
  it.effect("reads Hermes' per-session usage once per home, with its own costs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-usage-test-" }),
      );
      const db = yield* openDatabase(path.join(home, "state.db"));
      yield* db.unsafe(SCHEMA);
      const insert = (row: {
        readonly session: string;
        readonly model: string;
        readonly task?: string;
        readonly lastSeen: number;
        readonly status?: string;
        readonly estimated?: number;
        readonly actual?: number;
      }) =>
        db.unsafe(
          `INSERT INTO session_model_usage (session_id, model, task, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd,
             actual_cost_usd, cost_status, last_seen) VALUES (?, ?, ?, 100, 40, 900, 50, 10, ?, ?, ?, ?)`,
          [
            row.session,
            row.model,
            row.task ?? "",
            row.estimated ?? 0,
            row.actual ?? 0,
            row.status ?? null,
            row.lastSeen,
          ],
        );
      yield* insert({
        session: "s1",
        model: "claude-sonnet-4-5",
        lastSeen: IN_WINDOW_S,
        status: "actual",
        actual: 0.42,
        estimated: 0.4,
      });
      yield* insert({
        session: "s1",
        model: "gpt-5-mini",
        task: "compression",
        lastSeen: IN_WINDOW_S,
        status: "estimated",
        estimated: 0.01,
      });
      yield* insert({
        session: "s2",
        model: "rnd-glm",
        lastSeen: IN_WINDOW_S,
        status: "included",
        estimated: 1,
      });
      yield* insert({
        session: "old",
        model: "claude-sonnet-4-5",
        lastSeen: WINDOW_START_MS / 1000 - 1,
      });

      // A second instance on the same home must not count its ledger twice.
      const sources = yield* scan([
        { id: "hermes", home },
        { id: "hermes-work", home },
      ]).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      assert.lengthOf(sources, 1);
      assert.equal(sources[0]?.status, "ok");
      const records = sources[0]?.files?.flatMap((file) => file.records) ?? [];
      assert.deepStrictEqual(
        records
          .map((record) => [record.sessionId, record.model, record.reportedCostUsd] as const)
          .toSorted(),
        [
          ["s1", "claude-sonnet-4-5", 0.42],
          ["s1", "gpt-5-mini", 0.01],
          ["s2", "rnd-glm", null],
        ],
      );
      assert.deepStrictEqual(records[0]?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 900,
        cacheCreationTokens: 50,
        outputTokens: 40,
        reasoningTokens: 10,
      });
      assert.equal(records[0]?.timestampMs, IN_WINDOW_S * 1000);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a home with no ledger as absent and an unreadable one as partial", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const empty = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-usage-empty-" });
      const old = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-usage-old-" });
      const db = yield* openDatabase(path.join(old, "state.db"));
      yield* db.unsafe("CREATE TABLE sessions (id TEXT)");

      const [missing] = yield* scan([{ id: "hermes", home: empty }]);
      assert.isNull(missing?.files);
      const [partial] = yield* scan([{ id: "hermes", home: old }]);
      assert.equal(partial?.status, "partial");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
