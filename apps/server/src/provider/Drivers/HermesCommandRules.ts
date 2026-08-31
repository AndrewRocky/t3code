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
 * **The sync is additive-only, never destructive.** Hermes itself appends to
 * `command_allowlist` whenever a user answers "Allow always" to a live
 * approval prompt (`tools/approval.py save_permanent_allowlist`), and an
 * administrator may hand-edit either list directly — `config.yaml` is
 * documented as the supported surface for exactly that. A sync that replaced
 * either list wholesale from T3 settings would silently erase trust another
 * actor granted the moment T3's settings and the file next disagreed. So this
 * module only ever appends patterns present in T3 settings but absent from
 * the file; it never removes an entry, including one no longer configured in
 * T3. Removing a pattern for good means editing `config.yaml` directly (or
 * clearing the whole key) — T3 will not do it for you.
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
import { parse as parseYamlDocument, stringify as stringifyYamlDocument } from "yaml";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { resolveHermesHomePath } from "./HermesHome.ts";

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

export interface HermesCommandRulesMergeResult {
  readonly next: Record<string, unknown>;
  readonly changed: boolean;
}

export interface HermesCommandRules {
  readonly allowlist: ReadonlyArray<string>;
  readonly denylist: ReadonlyArray<string>;
}

/**
 * Additively merge T3's configured patterns into a parsed `config.yaml`
 * document. Exported for focused unit tests, separate from the file I/O.
 *
 * Returns `undefined` when the existing document root is present but is not
 * a mapping (a bare list or scalar `config.yaml`, or a YAML document whose
 * top level is not `key: value` pairs) — that file is left completely
 * untouched rather than replaced with a fresh map that would discard
 * whatever it actually held. Pass `undefined` for `existingConfig` for a
 * config.yaml that does not exist yet (or is empty, which `yaml.parse`
 * reports as `null`); either is treated as "no document yet".
 */
export function mergeHermesCommandRules(
  existingConfig: unknown,
  rules: HermesCommandRules,
): HermesCommandRulesMergeResult | undefined {
  if (existingConfig !== undefined && existingConfig !== null && !isPlainRecord(existingConfig)) {
    return undefined;
  }
  const base = isPlainRecord(existingConfig) ? existingConfig : {};

  const rawAllowlist = Array.isArray(base.command_allowlist) ? base.command_allowlist : [];
  const existingAllowlistStrings = rawAllowlist.filter(
    (entry): entry is string => typeof entry === "string",
  );
  const allowlistAdditions = missingPatterns(existingAllowlistStrings, rules.allowlist);

  const existingApprovals = isPlainRecord(base.approvals) ? base.approvals : {};
  const rawDenylist = Array.isArray(existingApprovals.deny) ? existingApprovals.deny : [];
  const existingDenylistStrings = rawDenylist.filter(
    (entry): entry is string => typeof entry === "string",
  );
  const denylistAdditions = missingPatterns(existingDenylistStrings, rules.denylist);

  if (allowlistAdditions.length === 0 && denylistAdditions.length === 0) {
    return { next: base, changed: false };
  }

  const next: Record<string, unknown> = { ...base };
  if (allowlistAdditions.length > 0) {
    next.command_allowlist = [...rawAllowlist, ...allowlistAdditions];
  }
  if (denylistAdditions.length > 0) {
    next.approvals = { ...existingApprovals, deny: [...rawDenylist, ...denylistAdditions] };
  }
  return { next, changed: true };
}

/**
 * Sync {@link HermesSettings.commandAllowlist} / `commandDenylist` into
 * `<HERMES_HOME>/config.yaml`, before a session spawns Hermes so the new
 * process reads them on its very first config load.
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
  if (hermesSettings.commandAllowlist.length === 0 && hermesSettings.commandDenylist.length === 0) {
    // Nothing configured: skip the read entirely rather than touch a file
    // the user may never otherwise need T3 to open.
    return;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* resolveHermesHomePath(hermesSettings, environment, cwd);
  const configPath = path.join(home, "config.yaml");

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

  const merged = mergeHermesCommandRules(parsed, {
    allowlist: hermesSettings.commandAllowlist,
    denylist: hermesSettings.commandDenylist,
  });
  if (merged === undefined) {
    yield* Effect.logWarning(
      "Hermes config.yaml root is not a mapping; leaving command_allowlist/approvals.deny unmanaged.",
      { configPath },
    );
    return;
  }
  if (!merged.changed) {
    return;
  }

  yield* writeFileStringAtomically({
    filePath: configPath,
    contents: stringifyYamlDocument(merged.next),
  }).pipe(
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.logWarning("Failed to write Hermes config.yaml command rules.", {
        configPath,
        cause: Cause.pretty(cause),
      }),
    ),
  );
});
