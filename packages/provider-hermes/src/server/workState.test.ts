import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { hermesSessionBusy, makeHermesAdmissionReader } from "./workState.ts";

/** The admissions table as Hermes creates it (`hermes_state_common.py`). */
const SESSION_ADMISSIONS_DDL = `CREATE TABLE session_admissions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, admission_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  lineage_json TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('queue','steer','redirect')),
  status TEXT NOT NULL CHECK (status IN ('queued','started','unknown','terminal')),
  outcome TEXT, owner_epoch INTEGER, generation INTEGER,
  UNIQUE (principal_id, target_session_id, request_id),
  CHECK (status != 'started' OR (owner_epoch IS NOT NULL AND generation IS NOT NULL)))`;

/** The `sessions` columns the lineage walk reads; Hermes' table has many more. */
const SESSIONS_DDL = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, model_config TEXT,
  parent_session_id TEXT, end_reason TEXT)`;

const makeStore = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-admissions-" });
  const databasePath = path.join(directory, "state.db");
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(SESSIONS_DDL);
  database.exec(SESSION_ADMISSIONS_DDL);
  let next = 0;
  const session = (
    id: string,
    fields: { parent?: string; endReason?: string; source?: string; modelConfig?: object } = {},
  ) =>
    database
      .prepare(
        "INSERT INTO sessions (id, source, model_config, parent_session_id, end_reason) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        id,
        fields.source ?? "acp",
        fields.modelConfig === undefined ? null : JSON.stringify(fields.modelConfig),
        fields.parent ?? null,
        fields.endReason ?? null,
      );
  const admit = (sessionId: string, status: "queued" | "started" | "unknown" | "terminal") => {
    next += 1;
    database
      .prepare(
        `INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id,
           lineage_json, payload_json, payload_digest, intent, status, owner_epoch, generation)
         VALUES (?, ?, 'acp', ?, '[]', '{}', 'digest', 'queue', ?, 1, 1)`,
      )
      .run(`adm-${String(next)}`, `req-${String(next)}`, sessionId, status);
    return `adm-${String(next)}`;
  };
  return { databasePath, directory, session, admit, close: () => database.close() };
});

it.layer(NodeServices.layer)("makeHermesAdmissionReader", (it) => {
  it.effect("counts the session's open admissions, through compression", () =>
    Effect.gen(function* () {
      const store = yield* makeStore();
      store.session("s-root", { endReason: "compression" });
      store.session("s-tip", { parent: "s-root" });
      store.session("s-branch", { parent: "s-root", modelConfig: { _branched_from: "s-root" } });
      store.session("s-other");
      store.admit("s-root", "terminal");
      store.admit("s-tip", "started");
      store.admit("s-tip", "queued");
      store.admit("s-branch", "started");
      store.admit("s-other", "started");
      const lost = store.admit("s-tip", "unknown");
      store.close();

      const admissions = yield* makeHermesAdmissionReader(store.databasePath)("s-root");
      expect(admissions).toEqual({ queued: 1, started: 1, lost: [lost] });
      expect(admissions !== undefined && hermesSessionBusy(admissions)).toBe(true);
    }),
  );

  it.effect("reports an idle session and fails open on an unreadable store", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const store = yield* makeStore();
      store.session("s-idle");
      store.admit("s-idle", "terminal");
      store.close();

      const idle = yield* makeHermesAdmissionReader(store.databasePath)("s-idle");
      expect(idle).toEqual({ queued: 0, started: 0, lost: [] });
      expect(idle !== undefined && hermesSessionBusy(idle)).toBe(false);
      expect(
        yield* makeHermesAdmissionReader(path.join(store.directory, "missing.db"))("s-idle"),
      ).toBeUndefined();
    }),
  );
});
