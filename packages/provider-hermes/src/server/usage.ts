import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type { HermesSettings } from "../settings.ts";
import { resolveHermesHomePath } from "./home.ts";

// Hermes keeps running totals per session, model and task, not per call, so a
// record is dated by its row's last activity.

interface UsageRow {
  readonly session_id: unknown;
  readonly model: unknown;
  readonly billing_provider: unknown;
  readonly billing_base_url: unknown;
  readonly billing_mode: unknown;
  readonly task: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly cache_read_tokens: unknown;
  readonly cache_write_tokens: unknown;
  readonly reasoning_tokens: unknown;
  readonly estimated_cost_usd: unknown;
  readonly actual_cost_usd: unknown;
  readonly cost_status: unknown;
  readonly last_seen: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Hermes' own cost when it knows one; `included` and `unknown` leave pricing to T3. */
function reportedCost(row: UsageRow): number | null {
  switch (row.cost_status) {
    case "actual":
      return positiveUsd(row.actual_cost_usd) ?? positiveUsd(row.estimated_cost_usd);
    case "estimated":
      return positiveUsd(row.estimated_cost_usd);
    default:
      return null;
  }
}

function hermesUsageRecord(row: UsageRow): UsageRecord | null {
  const sessionId = text(row.session_id);
  const model = text(row.model);
  const lastSeen = row.last_seen;
  if (!sessionId || !model || typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) {
    return null;
  }
  // Hermes' input excludes cache reads and writes; its reasoning is part of output.
  const totals = {
    uncachedInputTokens: tokenCount(row.input_tokens),
    cachedInputTokens: tokenCount(row.cache_read_tokens),
    cacheCreationTokens: tokenCount(row.cache_write_tokens),
    outputTokens: tokenCount(row.output_tokens),
    reasoningTokens: tokenCount(row.reasoning_tokens),
  };
  if (totalTokens(totals) === 0) return null;
  const route = [row.billing_provider, row.billing_base_url, row.billing_mode, row.task]
    .map(text)
    .join(":");
  return {
    provider: "hermes",
    timestampMs: Math.trunc(lastSeen * 1000),
    model,
    sessionId,
    totals,
    reportedCostUsd: reportedCost(row),
    speed: "standard",
    dedupeKey: `hermes:${sessionId}:${model}:${route}`,
  };
}

interface HermesUsageReadResult {
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: boolean;
}

const readHermesUsage = Effect.fn("readHermesUsage")(function* (
  databasePath: string,
  sinceMs: number,
): Effect.fn.Return<HermesUsageReadResult, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(databasePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return { records: [], missing: true, error: false };
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Fail promptly on the daemon's write locks instead of stalling the server.
    yield* sql.unsafe("PRAGMA busy_timeout = 100");
    const [table] = yield* sql.unsafe<{ readonly name: unknown }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_model_usage'",
    );
    if (table === undefined) return { records: [], missing: false, error: true };
    const rows = yield* sql.unsafe<UsageRow>(
      `SELECT session_id, model, billing_provider, billing_base_url, billing_mode, task,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
              estimated_cost_usd, actual_cost_usd, cost_status, last_seen
       FROM session_model_usage WHERE last_seen >= ?`,
      [sinceMs / 1000],
    );
    const records = rows.flatMap((row) => {
      const record = hermesUsageRecord(row);
      return record === null ? [] : [record];
    });
    return { records, missing: false, error: false };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
    Effect.catchTags({
      SqlError: () => Effect.succeed({ records: [], missing: false, error: true }),
    }),
  );
});

export type HermesUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const hermesUsageReader: ProviderUsageReader<HermesSettings, HermesUsageReaderEnv> = {
  kind: "scan",
  provider: "hermes",
  scan: Effect.fn("hermesUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Instances sharing a Hermes home share one ledger, so it counts once.
    const homes = new Set<string>();
    for (const instance of instances) {
      const home = yield* resolveHermesHomePath(
        instance.config ?? { homePath: "" },
        instance.environment,
      );
      homes.add(yield* fileSystem.realPath(home).pipe(Effect.orElseSucceed(() => home)));
    }
    return yield* Effect.forEach(
      homes,
      (dir) =>
        readHermesUsage(path.join(dir, "state.db"), windowStartMs).pipe(
          Effect.map((result) => ({
            dir,
            files:
              result.missing && !result.error
                ? null
                : [{ path: path.join(dir, "state.db"), records: result.records }],
            status: result.error ? ("partial" as const) : ("ok" as const),
            ...(result.error ? { message: "Hermes' usage records could not be read." } : {}),
          })),
        ),
      { concurrency: "unbounded" },
    );
  }),
};
