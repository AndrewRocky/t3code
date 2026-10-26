import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { parse as parseYamlDocument, stringify as stringifyYamlDocument } from "yaml";

import type { HermesSettings } from "../settings.ts";
import { resolveHermesHomePath, withHermesConfigLock } from "./home.ts";

// Hermes' ACP modes gate edits only; commands go through `tools/approval.py`,
// which reads `command_allowlist` (fnmatch, case-sensitive, never for compound
// commands) and `approvals.deny` (case-insensitive, enforced even under YOLO)
// from `config.yaml`. Neither has an ACP surface, so T3 syncs its Command
// rules into that file.
//
// T3 is not the only writer: Hermes appends "Allow always" answers to the
// allowlist and administrators hand-edit both lists. So the sync manages T3's
// own entries only, recorded in a provenance sidecar: it adds configured
// patterns, removes ones T3 wrote and no longer configures, and leaves every
// other entry alone. A missing or unreadable record makes the sync
// additive-only. A concurrent Hermes write can win the rename; both sides
// self-heal on their next read, so no cross-process lock is taken.

/**
 * Beside the `config.yaml` it describes, so instances sharing one home agree on
 * what T3 claimed there. Hermes never reads it.
 */
export const HERMES_COMMAND_RULES_PROVENANCE_FILE = ".t3code-command-rules.json";

/** Schema version of the provenance sidecar; an unrecognised value is ignored. */
const PROVENANCE_VERSION = 1;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type YamlParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/** Plain (non-Effect) wrapper so a YAML parse failure never needs try/catch inside a generator. */
function tryParseYaml(raw: string): YamlParseResult {
  try {
    return { ok: true, value: parseYamlDocument(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Non-empty entries of `patterns`, deduplicated, in configured order. */
function sanitizePatterns(patterns: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const sanitized: Array<string> = [];
  for (const pattern of patterns) {
    if (pattern.length === 0 || seen.has(pattern)) continue;
    seen.add(pattern);
    sanitized.push(pattern);
  }
  return sanitized;
}

/** Patterns from `configured` that are not already in `existing`, in configured order, deduped. */
function missingPatterns(
  existing: ReadonlyArray<string>,
  configured: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const present = new Set(existing);
  const additions: Array<string> = [];
  for (const pattern of configured) {
    if (pattern.length > 0 && !present.has(pattern) && !additions.includes(pattern)) {
      additions.push(pattern);
    }
  }
  return additions;
}

function sameListContents(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Patterns T3 previously wrote that are no longer configured, and so should be revoked. */
function revokedPatterns(
  previouslySynced: ReadonlyArray<string> | undefined,
  configured: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (previouslySynced === undefined || previouslySynced.length === 0) return new Set();
  const stillConfigured = new Set(configured);
  return new Set(previouslySynced.filter((pattern) => !stillConfigured.has(pattern)));
}

/** One list's merge outcome: the entries to write, plus what changed and why. */
interface ListMerge {
  readonly next: ReadonlyArray<unknown>;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly changed: boolean;
}

function mergeList(
  rawExisting: ReadonlyArray<unknown>,
  configured: ReadonlyArray<string>,
  previouslySynced: ReadonlyArray<string> | undefined,
): ListMerge {
  const revoked = revokedPatterns(previouslySynced, configured);
  const removed = rawExisting.filter(
    (entry): entry is string => typeof entry === "string" && revoked.has(entry),
  );
  // Non-string entries (a malformed hand-edit) are carried through verbatim:
  // T3 cannot have written one, so it is not T3's to drop.
  const kept = rawExisting.filter((entry) => !(typeof entry === "string" && revoked.has(entry)));
  const keptStrings = kept.filter((entry): entry is string => typeof entry === "string");
  const added = missingPatterns(keptStrings, configured);
  return {
    next: [...kept, ...added],
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
  };
}

export interface HermesCommandRules {
  readonly allowlist: ReadonlyArray<string>;
  readonly denylist: ReadonlyArray<string>;
}

export interface HermesCommandRulesMergeResult {
  readonly next: Record<string, unknown>;
  readonly changed: boolean;
  /** Patterns appended to the file by this merge. */
  readonly added: HermesCommandRules;
  /** Patterns removed because T3 wrote them before and no longer configures them. */
  readonly removed: HermesCommandRules;
  /**
   * The set T3 now claims authorship of — the configured patterns, all of
   * which are present in {@link next}. Persist this as the provenance record
   * once the merged document is on disk.
   */
  readonly synced: HermesCommandRules;
}

/**
 * Merge T3's configured patterns into a parsed `config.yaml` document.
 * Exported for focused unit tests, separate from the file I/O.
 *
 * `previouslySynced` is the provenance record — the patterns T3 wrote into
 * this same file on its last sync. Entries listed there and no longer
 * configured are removed; everything else in the file is preserved. Omit it
 * (or pass `undefined`) when the record is missing or unreadable, which makes
 * the merge purely additive so that an entry of unknown authorship is never
 * dropped.
 *
 * Returns `undefined` when the existing document root is present but is not
 * a mapping (a bare list or scalar `config.yaml`, or a YAML document whose
 * top level is not `key: value` pairs) — that file is left completely
 * untouched rather than replaced with a fresh map that would discard
 * whatever it actually held. Pass `undefined` for `existingConfig` for a
 * config.yaml that does not exist yet (or is empty, which `yaml.parse`
 * reports as `null`); either is treated as "no document yet".
 *
 * A list that ends up empty has its key dropped rather than written as `[]`
 * — the two are equivalent to Hermes, and dropping it leaves no trace of a
 * rule set the user has cleared. An `approvals` mapping left with no keys at
 * all is dropped for the same reason.
 */
export function mergeHermesCommandRules(
  existingConfig: unknown,
  rules: HermesCommandRules,
  previouslySynced?: HermesCommandRules,
): HermesCommandRulesMergeResult | undefined {
  if (existingConfig !== undefined && existingConfig !== null && !isPlainRecord(existingConfig)) {
    return undefined;
  }
  const base = isPlainRecord(existingConfig) ? existingConfig : {};

  const configuredAllowlist = sanitizePatterns(rules.allowlist);
  const configuredDenylist = sanitizePatterns(rules.denylist);
  const synced: HermesCommandRules = {
    allowlist: configuredAllowlist,
    denylist: configuredDenylist,
  };

  const rawAllowlist = Array.isArray(base.command_allowlist) ? base.command_allowlist : [];
  const allowlist = mergeList(rawAllowlist, configuredAllowlist, previouslySynced?.allowlist);

  const existingApprovals = isPlainRecord(base.approvals) ? base.approvals : {};
  const rawDenylist = Array.isArray(existingApprovals.deny) ? existingApprovals.deny : [];
  const denylist = mergeList(rawDenylist, configuredDenylist, previouslySynced?.denylist);

  const added: HermesCommandRules = { allowlist: allowlist.added, denylist: denylist.added };
  const removed: HermesCommandRules = { allowlist: allowlist.removed, denylist: denylist.removed };

  if (!allowlist.changed && !denylist.changed) {
    return { next: base, changed: false, added, removed, synced };
  }

  const next: Record<string, unknown> = { ...base };
  if (allowlist.changed) {
    if (allowlist.next.length === 0) {
      delete next.command_allowlist;
    } else {
      next.command_allowlist = [...allowlist.next];
    }
  }
  if (denylist.changed) {
    const nextApprovals: Record<string, unknown> = { ...existingApprovals };
    if (denylist.next.length === 0) {
      delete nextApprovals.deny;
    } else {
      nextApprovals.deny = [...denylist.next];
    }
    if (Object.keys(nextApprovals).length === 0) {
      delete next.approvals;
    } else {
      next.approvals = nextApprovals;
    }
  }
  return { next, changed: true, added, removed, synced };
}

/**
 * On-disk shape of the provenance sidecar. `version` gates breaking changes:
 * a record this build does not understand decodes as a failure, and the sync
 * falls back to additive-only rather than removing entries on the strength of
 * a record it cannot read.
 */
const HermesCommandRulesProvenanceFile = Schema.Struct({
  version: Schema.Literal(PROVENANCE_VERSION),
  commandAllowlist: Schema.Array(Schema.String),
  commandDenylist: Schema.Array(Schema.String),
});
const HermesCommandRulesProvenanceJson = Schema.fromJsonString(
  HermesCommandRulesProvenanceFile as unknown as Schema.Codec<
    typeof HermesCommandRulesProvenanceFile.Type
  >,
);
const decodeProvenance = Schema.decodeUnknownEffect(HermesCommandRulesProvenanceJson);
const encodeProvenance = Schema.encodeSync(HermesCommandRulesProvenanceJson);

/** Serialize the provenance sidecar. Exported for the tests that assert its shape. */
export function serializeHermesCommandRulesProvenance(rules: HermesCommandRules): string {
  return `${encodeProvenance({
    version: PROVENANCE_VERSION,
    commandAllowlist: rules.allowlist,
    commandDenylist: rules.denylist,
  })}\n`;
}

/**
 * Sync {@link HermesSettings.commandAllowlist} / `commandDenylist` into
 * `<HERMES_HOME>/config.yaml`, before a session spawns Hermes so the new
 * process reads them on its very first config load. Patterns T3 wrote on a
 * previous sync and no longer configures are removed; see the module doc for
 * why nothing else in either list is ever touched.
 *
 * Best-effort and total: an unreadable, unparseable, or non-map config.yaml
 * is left alone with a logged warning rather than risking data loss on a
 * file Hermes itself (and possibly an administrator) also writes. A session
 * start never fails because this sync could not run.
 */
export const syncHermesCommandRules = Effect.fn("syncHermesCommandRules")(function* (
  hermesSettings: Pick<HermesSettings, "homePath" | "commandAllowlist" | "commandDenylist">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const home = yield* resolveHermesHomePath(hermesSettings, environment, cwd);
  yield* withHermesConfigLock(home, syncHermesCommandRulesInHome(hermesSettings, home));
});

const syncHermesCommandRulesInHome = Effect.fn("syncHermesCommandRulesInHome")(function* (
  hermesSettings: Pick<HermesSettings, "commandAllowlist" | "commandDenylist">,
  home: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(home, "config.yaml");
  const provenancePath = path.join(home, HERMES_COMMAND_RULES_PROVENANCE_FILE);

  const configuredAllowlist = sanitizePatterns(hermesSettings.commandAllowlist);
  const configuredDenylist = sanitizePatterns(hermesSettings.commandDenylist);

  // T3's own sidecar, read first: with nothing configured *and* nothing
  // previously claimed there is no work to do, and Hermes' config.yaml is
  // never opened at all.
  const provenanceRaw = yield* fileSystem
    .readFileString(provenancePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const previouslySynced =
    provenanceRaw === undefined
      ? undefined
      : yield* decodeProvenance(provenanceRaw).pipe(
          Effect.map((record): HermesCommandRules => ({
            allowlist: record.commandAllowlist,
            denylist: record.commandDenylist,
          })),
          Effect.catchCause((cause: Cause.Cause<unknown>) =>
            Effect.logWarning(
              "Hermes command-rule provenance file is unreadable; syncing additively without removals.",
              { provenancePath, cause: Cause.pretty(cause) },
            ).pipe(Effect.as(undefined)),
          ),
        );

  const hasConfigured = configuredAllowlist.length > 0 || configuredDenylist.length > 0;
  const hasClaimed =
    previouslySynced !== undefined &&
    (previouslySynced.allowlist.length > 0 || previouslySynced.denylist.length > 0);
  if (!hasConfigured && !hasClaimed) {
    return;
  }

  const raw = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));

  let parsed: unknown;
  if (raw !== undefined) {
    const parseResult = tryParseYaml(raw);
    if (!parseResult.ok) {
      yield* Effect.logWarning(
        "Hermes config.yaml has invalid YAML; leaving command_allowlist/approvals.deny unmanaged.",
        { configPath, error: parseResult.error },
      );
      return;
    }
    parsed = parseResult.value;
  }

  const merged = mergeHermesCommandRules(
    parsed,
    { allowlist: configuredAllowlist, denylist: configuredDenylist },
    previouslySynced,
  );
  if (merged === undefined) {
    yield* Effect.logWarning(
      "Hermes config.yaml root is not a mapping; leaving command_allowlist/approvals.deny unmanaged.",
      { configPath },
    );
    return;
  }

  if (merged.changed) {
    const wrote = yield* writeFileStringAtomically({
      filePath: configPath,
      contents: stringifyYamlDocument(merged.next),
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Effect.logWarning("Failed to write Hermes config.yaml command rules.", {
          configPath,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
    // Leave the provenance record describing what is actually on disk: a
    // failed write means T3 still owns exactly what it owned before, and the
    // next session start recomputes the same additions and removals.
    if (!wrote) return;
    if (merged.removed.allowlist.length > 0 || merged.removed.denylist.length > 0) {
      yield* Effect.logInfo("Revoked Hermes command rules removed from T3 Code settings.", {
        configPath,
        allowlist: merged.removed.allowlist,
        denylist: merged.removed.denylist,
      });
    }
  }

  const provenanceUpToDate =
    previouslySynced !== undefined &&
    sameListContents(previouslySynced.allowlist, merged.synced.allowlist) &&
    sameListContents(previouslySynced.denylist, merged.synced.denylist);
  if (provenanceUpToDate) return;

  const claimsNothing = merged.synced.allowlist.length === 0 && merged.synced.denylist.length === 0;
  if (claimsNothing) {
    // Every rule T3 added has been revoked: drop the sidecar rather than
    // leave an empty record behind in the user's Hermes home.
    yield* fileSystem.remove(provenancePath).pipe(Effect.ignore);
    return;
  }

  yield* writeFileStringAtomically({
    filePath: provenancePath,
    contents: serializeHermesCommandRulesProvenance(merged.synced),
  }).pipe(
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.logWarning("Failed to record Hermes command-rule provenance.", {
        provenancePath,
        cause: Cause.pretty(cause),
      }),
    ),
  );
});
