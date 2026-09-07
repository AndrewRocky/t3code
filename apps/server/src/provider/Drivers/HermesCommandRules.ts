/**
 * HermesCommandRules — sync T3's configured command allow/deny patterns into
 * Hermes' own `config.yaml`.
 *
 * Hermes' three ACP session modes gate file edits only; shell commands always
 * round-trip through `session/request_permission` regardless of mode
 * (`hermesModeIdForRuntimeMode` in `../acp/HermesAcpSupport.ts`). Hermes does
 * have its own command-level granularity, but it lives entirely on its side
 * of the process boundary, in `tools/approval.py check_dangerous_command()`:
 *
 * - `command_allowlist` at the config root — `fnmatch` glob patterns
 *   (`podman *`, `cargo test*`) matched against the literal command text.
 *   A match short-circuits before Hermes ever calls
 *   `session/request_permission`, so an allowlisted command never reaches
 *   T3 Code as a permission prompt at all. Matching is case-sensitive and
 *   silently declines to match any command containing shell operators
 *   (`&&`, `;`, `$(...)`, pipes, backticks) even when the literal prefix
 *   would otherwise match — Hermes treats a compound command as unsafe to
 *   shortcut this way (`_has_allowlist_shell_operator`).
 * - `approvals.deny` — `fnmatch` glob patterns (case-insensitive, matched
 *   against deobfuscated command variants) that block a command
 *   unconditionally: even under Hermes' own `--yolo`, even when
 *   `approvals.mode` is `off`, and — because T3's Full access maps to
 *   `dont_ask` plus the adapter auto-answering every permission prompt —
 *   even when T3 would otherwise auto-approve it. This is the hard floor a
 *   runtime-mode auto-approval cannot override.
 *
 * Neither key has an ACP protocol surface (`initialize` advertises no config
 * option for either — `acp_adapter/server.py` documents its config-option
 * passthrough as unread outside the edit-approval-policy one). The only way
 * to reach them is the config file Hermes reads at `<HERMES_HOME>/config.yaml`
 * (mtime-cached, so an edit while the ACP server runs is picked up without a
 * restart) — which is exactly the file T3 already resolves per-instance via
 * {@link resolveHermesHomePath} for skill discovery. This module manages the
 * same file's `command_allowlist` and `approvals.deny` keys from
 * {@link HermesSettings.commandAllowlist} / {@link HermesSettings.commandDenylist}.
 *
 * **The sync manages T3's own entries only, tracked by provenance.** T3 is not
 * the sole writer of either key. Hermes itself appends to `command_allowlist`
 * whenever a user answers "Allow always" to a live approval prompt
 * (`tools/approval.py save_permanent_allowlist`), and an administrator may
 * hand-edit either list directly — `config.yaml` is documented as the
 * supported surface for exactly that. So a sync that replaced either list
 * wholesale from T3 settings would silently erase trust another actor
 * granted the moment T3's settings and the file next disagreed.
 *
 * Instead, T3 records the exact set of patterns it last wrote into a given
 * Hermes home, in {@link HERMES_COMMAND_RULES_PROVENANCE_FILE} beside that
 * `config.yaml`, and each sync then:
 *
 * - **adds** configured patterns missing from the file, as before;
 * - **removes** patterns that are in the recorded set but no longer
 *   configured in T3 — the pattern the user just deleted in Settings, and
 *   only that;
 * - **leaves every other entry alone**, including one Hermes appended from an
 *   "Allow always" answer and one an administrator typed in by hand.
 *
 * Removing a pattern in Settings therefore actually revokes it, which is what
 * the UI has always claimed; a foreign entry still survives a T3 sync, which
 * is what makes that safe. If the provenance record is missing or unreadable
 * — a fresh T3 install pointed at an existing Hermes home, a hand-cleared
 * state file — the sync degrades to the additive-only behaviour rather than
 * guessing at authorship, so an unknown entry is never removed on a hunch.
 * Clearing an entry T3 never wrote still means editing `config.yaml` directly.
 *
 * A narrow, accepted race exists between this module and Hermes' own
 * concurrent `save_permanent_allowlist` write: if a user answers "Allow
 * always" in one session at the exact moment another session start re-syncs
 * this file, the later writer wins the atomic rename and could drop the
 * other's change from disk. Both sides are self-healing — Hermes reloads its
 * in-memory set from the file on its own next read, and this module recomputes
 * the same additions from T3 settings on its own next session start — so the
 * failure mode is a transient omission, never corruption or a stuck state,
 * which is why no cross-process lock guards the read-modify-write below.
 *
 * @module provider/Drivers/HermesCommandRules
 */
import type { HermesSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument, stringify as stringifyYamlDocument } from "yaml";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { resolveHermesHomePath } from "./HermesHome.ts";

/**
 * T3-owned sidecar, beside the `config.yaml` it describes, recording the
 * patterns T3 last synced into that file.
 *
 * It lives in the Hermes home rather than T3's own state directory because
 * the thing it describes is the file, not the T3 instance: two T3 instances
 * pointed at one `HERMES_HOME` write the same `config.yaml` and must agree on
 * what T3 has claimed there, and a Hermes home that is moved, copied, or
 * deleted should carry (or lose) that record with it. Hermes never reads it —
 * a dotfile at the root of the home is outside everything it loads.
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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* resolveHermesHomePath(hermesSettings, environment, cwd);
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
          Effect.map(
            (record): HermesCommandRules => ({
              allowlist: record.commandAllowlist,
              denylist: record.commandDenylist,
            }),
          ),
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
