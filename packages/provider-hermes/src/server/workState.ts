import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";

// ACP has no busy signal, and the gateway runs every admitted prompt whether a
// viewer is attached or not. This reads that per-session FIFO
// (`session_admissions` in `<HERMES_HOME>/state.db`) read-only.

/** Compression continues a conversation in a child session; admissions target the live tip. */
const ADMISSIONS_SQL = `
WITH RECURSIVE lineage(id) AS (
  SELECT ?
  UNION
  SELECT child.id
  FROM lineage
  JOIN sessions parent ON parent.id = lineage.id
  JOIN sessions child ON child.parent_session_id = parent.id
  WHERE parent.end_reason = 'compression'
    AND COALESCE(child.source, '') != 'tool'
    AND (json_valid(child.model_config) = 0
      OR (json_extract(child.model_config, '$._branched_from') IS NULL
        AND json_extract(child.model_config, '$._delegate_from') IS NULL))
)
SELECT admission_id, status FROM session_admissions
WHERE target_session_id IN (SELECT id FROM lineage)
  AND status IN ('queued', 'started', 'unknown')`;

export interface HermesAdmissions {
  readonly queued: number;
  readonly started: number;
  /** Admissions whose outcome Hermes lost; they block the session until `/discard <id>`. */
  readonly lost: ReadonlyArray<string>;
}

/** `undefined` when the store cannot be read: a remote gateway, schema drift, or no file yet. */
export type HermesAdmissionReader = (
  sessionId: string,
) => Effect.Effect<HermesAdmissions | undefined>;

export function hermesSessionBusy(admissions: HermesAdmissions): boolean {
  return admissions.queued + admissions.started > 0;
}

export const makeHermesAdmissionReader =
  (databasePath: string): HermesAdmissionReader =>
  (sessionId) =>
    Effect.try(() => {
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const rows = database.prepare(ADMISSIONS_SQL).all(sessionId);
        let queued = 0;
        let started = 0;
        const lost: Array<string> = [];
        for (const row of rows) {
          if (row.status === "queued") queued += 1;
          else if (row.status === "started") started += 1;
          else if (typeof row.admission_id === "string") lost.push(row.admission_id);
        }
        return { queued, started, lost } satisfies HermesAdmissions;
      } finally {
        database.close();
      }
    }).pipe(Effect.orElseSucceed(() => undefined));
