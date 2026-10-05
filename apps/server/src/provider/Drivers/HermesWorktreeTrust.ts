/**
 * HermesWorktreeTrust — extend `hermes skills trust` from a project's main
 * checkout to its linked git worktrees, when
 * {@link HermesSettings.trustWorktreesOfTrustedProjects} is on.
 *
 * Hermes loads a project's `.hermes/skills` and `.agents/skills` only when the
 * project root is listed in `skills.trusted_project_dirs`, and it finds that
 * root by walking up to the nearest `.git` (`agent/skill_utils.py:find_project_root`).
 * In a linked worktree that is the worktree's own `.git` *file*, and the trust
 * check is an exact path match, so every worktree is a separate, untrusted
 * project however trusted its main checkout is. T3 creates a worktree per
 * thread, so without help project skills vanish from worktree threads.
 *
 * Trust is written where it has to be read. Hermes fixes the trust list when a
 * session starts, so the adapter syncs before spawning `hermes acp`; and the
 * picker's per-workspace snapshot syncs before running
 * `hermes skills list`, because the thread learns its worktree path before any
 * setup script has had a chance to run, and that snapshot is kept for the
 * server's lifetime once taken.
 *
 * **T3 manages only the entries it added**, tracked by provenance exactly as
 * `./HermesCommandRules.ts` does: a sidecar beside `config.yaml` records each
 * worktree path T3 trusted. An entry is revoked when its worktree no longer
 * exists — so a later worktree created at the same path does not silently
 * inherit trust — and every T3 entry is revoked when the setting is turned
 * off. Entries the user added with `hermes skills trust` are never touched.
 *
 * @module provider/Drivers/HermesWorktreeTrust
 */
import type { HermesSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument, stringify as stringifyYamlDocument } from "yaml";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import {
  expandHermesConfigPath,
  resolveHermesHomePath,
  withHermesConfigLock,
} from "./HermesHome.ts";
import { findHermesProjectRoot } from "./HermesSkills.ts";

/**
 * T3-owned sidecar, beside the `config.yaml` it describes, recording the
 * worktree paths T3 added to `skills.trusted_project_dirs`. It lives in the
 * Hermes home for the reason the command-rule sidecar does: it describes that
 * file, not a T3 instance. Hermes never reads it.
 */
export const HERMES_WORKTREE_TRUST_PROVENANCE_FILE = ".t3code-worktree-trust.json";

const PROVENANCE_VERSION = 1;

const HermesWorktreeTrustProvenanceFile = Schema.Struct({
  version: Schema.Literal(PROVENANCE_VERSION),
  trustedWorktrees: Schema.Array(Schema.String),
});
const HermesWorktreeTrustProvenanceJson = Schema.fromJsonString(
  HermesWorktreeTrustProvenanceFile as unknown as Schema.Codec<
    typeof HermesWorktreeTrustProvenanceFile.Type
  >,
);
const decodeProvenance = Schema.decodeUnknownEffect(HermesWorktreeTrustProvenanceJson);
const encodeProvenance = Schema.encodeSync(HermesWorktreeTrustProvenanceJson);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type YamlParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

function tryParseYaml(raw: string): YamlParseResult {
  try {
    return { ok: true, value: parseYamlDocument(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** `skills.trusted_project_dirs` as Hermes reads it: a string or a list of strings. */
function trustedProjectEntries(config: unknown): ReadonlyArray<string> {
  if (!isPlainRecord(config) || !isPlainRecord(config.skills)) return [];
  const raw = config.skills.trusted_project_dirs;
  const entries = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
}

const resolveRealPath = Effect.fn("resolveRealPath")(function* (value: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
});

/**
 * The main checkout of the linked worktree rooted at `projectRoot`, or
 * `undefined` when `projectRoot` is not a linked worktree of a non-bare repo.
 *
 * Read from git's on-disk layout rather than by spawning git: a linked
 * worktree's `.git` is a file naming its gitdir (absolute, or relative to the
 * worktree under `worktree.useRelativePaths`), and only a worktree gitdir
 * holds a `commondir` file pointing at the shared `.git`. A submodule also has
 * a `.git` file but no `commondir`, so trusting a superproject never reaches
 * its submodules; a worktree of a bare repository has a common dir that is not
 * a checkout's `.git`, so there is no main checkout to inherit from.
 */
export const resolveLinkedWorktreeMainRoot = Effect.fn("resolveLinkedWorktreeMainRoot")(function* (
  projectRoot: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A normal checkout's `.git` is a directory, which does not read as a file.
  const gitFile = yield* fileSystem
    .readFileString(path.join(projectRoot, ".git"))
    .pipe(Effect.orElseSucceed(() => undefined));
  const gitDirValue =
    gitFile === undefined ? undefined : /^gitdir:\s*(.+?)\s*$/m.exec(gitFile)?.[1];
  if (gitDirValue === undefined) return undefined;

  const gitDir = path.resolve(projectRoot, gitDirValue);
  const commonDirValue = yield* fileSystem
    .readFileString(path.join(gitDir, "commondir"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (commonDirValue === undefined || commonDirValue.trim().length === 0) return undefined;

  const commonDir = path.resolve(gitDir, commonDirValue.trim());
  if (path.basename(commonDir) !== ".git") return undefined;
  return yield* resolveRealPath(path.dirname(commonDir));
});

export interface HermesWorktreeTrustMergeResult {
  readonly next: Record<string, unknown>;
  readonly changed: boolean;
  /** The entry appended by this merge, if any. */
  readonly added: string | undefined;
  /** Entries removed because they were in the `remove` set. */
  readonly removed: ReadonlyArray<string>;
}

/**
 * Apply one addition and a set of removals to `skills.trusted_project_dirs` in
 * a parsed `config.yaml`. Exported for focused unit tests, separate from the
 * file I/O.
 *
 * Returns `undefined`, leaving the file untouched, when the document root or
 * its `skills` value is not a mapping, or `trusted_project_dirs` holds
 * something other than a string or a list — a shape T3 did not write and
 * should not replace. Non-string list entries are carried through verbatim.
 * A list left empty drops its key, and a `skills` mapping left empty drops
 * too, as in the command-rule merge.
 */
export function mergeHermesWorktreeTrust(
  existingConfig: unknown,
  change: { readonly add: string | undefined; readonly remove: ReadonlySet<string> },
): HermesWorktreeTrustMergeResult | undefined {
  if (existingConfig !== undefined && existingConfig !== null && !isPlainRecord(existingConfig)) {
    return undefined;
  }
  const base = isPlainRecord(existingConfig) ? existingConfig : {};
  const rawSkills = base.skills;
  if (rawSkills !== undefined && rawSkills !== null && !isPlainRecord(rawSkills)) {
    return undefined;
  }
  const skills = isPlainRecord(rawSkills) ? rawSkills : {};
  const rawEntries = skills.trusted_project_dirs;
  if (
    rawEntries !== undefined &&
    rawEntries !== null &&
    typeof rawEntries !== "string" &&
    !Array.isArray(rawEntries)
  ) {
    return undefined;
  }
  const entries: ReadonlyArray<unknown> =
    typeof rawEntries === "string" ? [rawEntries] : Array.isArray(rawEntries) ? rawEntries : [];

  const isRemoved = (entry: unknown): entry is string =>
    typeof entry === "string" && change.remove.has(entry);
  const removed = entries.filter(isRemoved);
  const kept = entries.filter((entry) => !isRemoved(entry));
  const added = change.add !== undefined && !kept.includes(change.add) ? change.add : undefined;
  if (added === undefined && removed.length === 0) {
    return { next: base, changed: false, added: undefined, removed: [] };
  }

  const nextEntries = added === undefined ? kept : [...kept, added];
  const nextSkills: Record<string, unknown> = { ...skills };
  if (nextEntries.length === 0) {
    delete nextSkills.trusted_project_dirs;
  } else {
    nextSkills.trusted_project_dirs = [...nextEntries];
  }
  const next: Record<string, unknown> = { ...base };
  if (Object.keys(nextSkills).length === 0) {
    delete next.skills;
  } else {
    next.skills = nextSkills;
  }
  return { next, changed: true, added, removed };
}

/** Serialize the provenance sidecar. Exported for the tests that assert its shape. */
export function serializeHermesWorktreeTrustProvenance(
  trustedWorktrees: ReadonlyArray<string>,
): string {
  return `${encodeProvenance({ version: PROVENANCE_VERSION, trustedWorktrees })}\n`;
}

/**
 * Bring this Hermes home's trust list in line with
 * {@link HermesSettings.trustWorktreesOfTrustedProjects} for `cwd`.
 *
 * With the setting on and `cwd` inside a linked worktree whose main checkout
 * is trusted, the worktree root is added. Separately, T3's own earlier
 * additions are revoked — all of them when the setting is off, otherwise only
 * those whose worktree is gone.
 *
 * Cheap when there is nothing to do: with the setting off and nothing claimed
 * it reads one missing sidecar, and outside a linked worktree it never opens
 * `config.yaml`. Best-effort and total, like the command-rule sync: an
 * unreadable or unexpected `config.yaml` is left alone with a warning, and a
 * session start never fails because of this.
 */
export const syncHermesWorktreeTrust = Effect.fn("syncHermesWorktreeTrust")(function* (
  hermesSettings: Pick<HermesSettings, "homePath" | "trustWorktreesOfTrustedProjects">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const home = yield* resolveHermesHomePath(hermesSettings, environment, cwd);
  yield* withHermesConfigLock(
    home,
    syncHermesWorktreeTrustInHome({
      home,
      enabled: hermesSettings.trustWorktreesOfTrustedProjects,
      environment,
      cwd,
    }),
  );
});

const syncHermesWorktreeTrustInHome = Effect.fn("syncHermesWorktreeTrustInHome")(function* (input: {
  readonly home: string;
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(input.home, "config.yaml");
  const provenancePath = path.join(input.home, HERMES_WORKTREE_TRUST_PROVENANCE_FILE);

  // An unreadable record claims nothing: an entry of unknown authorship is
  // never removed on a hunch.
  const provenanceRaw = yield* fileSystem
    .readFileString(provenancePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const claimed: ReadonlyArray<string> =
    provenanceRaw === undefined
      ? []
      : yield* decodeProvenance(provenanceRaw).pipe(
          Effect.map((record) => record.trustedWorktrees),
          Effect.catchCause((cause: Cause.Cause<unknown>) =>
            Effect.logWarning(
              "Hermes worktree-trust provenance file is unreadable; revoking nothing.",
              { provenancePath, cause: Cause.pretty(cause) },
            ).pipe(Effect.as([] as ReadonlyArray<string>)),
          ),
        );

  const revoke: Array<string> = [];
  for (const entry of claimed) {
    const stillThere = input.enabled
      ? yield* fileSystem.exists(entry).pipe(Effect.orElseSucceed(() => false))
      : false;
    if (!stillThere) revoke.push(entry);
  }

  const projectRoot =
    input.enabled && input.cwd !== undefined ? yield* findHermesProjectRoot(input.cwd) : undefined;
  const mainRoot =
    projectRoot === undefined ? undefined : yield* resolveLinkedWorktreeMainRoot(projectRoot);
  const candidate =
    projectRoot !== undefined && mainRoot !== undefined ? { projectRoot, mainRoot } : undefined;

  if (candidate === undefined && revoke.length === 0) return;

  const raw = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  let parsed: unknown;
  if (raw !== undefined) {
    const parseResult = tryParseYaml(raw);
    if (!parseResult.ok) {
      yield* Effect.logWarning(
        "Hermes config.yaml has invalid YAML; leaving skills.trusted_project_dirs unmanaged.",
        { configPath, error: parseResult.error },
      );
      return;
    }
    parsed = parseResult.value;
  }

  let add: string | undefined;
  if (candidate !== undefined) {
    // Hermes resolves each entry (`_expand_path(entry).resolve()`), so a
    // `~`, `$VAR`, or symlinked spelling of the main checkout still counts.
    const trusted = new Set<string>();
    for (const entry of trustedProjectEntries(parsed)) {
      const expanded = expandHermesConfigPath(entry, input.environment);
      trusted.add(yield* resolveRealPath(path.resolve(input.cwd ?? "", expanded)));
    }
    if (trusted.has(candidate.mainRoot) && !trusted.has(candidate.projectRoot)) {
      add = candidate.projectRoot;
    }
  }

  const merged = mergeHermesWorktreeTrust(parsed, { add, remove: new Set(revoke) });
  if (merged === undefined) {
    yield* Effect.logWarning(
      "Hermes config.yaml has an unexpected skills shape; leaving skills.trusted_project_dirs unmanaged.",
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
        Effect.logWarning("Failed to write Hermes worktree trust to config.yaml.", {
          configPath,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
    // Leave the provenance record describing what is actually on disk.
    if (!wrote) return;
    if (merged.added !== undefined && candidate !== undefined) {
      yield* Effect.logInfo("Trusted a Hermes worktree of a trusted project.", {
        worktree: merged.added,
        project: candidate.mainRoot,
        configPath,
      });
    }
    if (merged.removed.length > 0) {
      yield* Effect.logInfo(
        input.enabled
          ? "Revoked Hermes trust T3 Code had added for worktrees that no longer exist."
          : "Revoked the Hermes worktree trust T3 Code had added, now that the setting is off.",
        { worktrees: merged.removed, configPath },
      );
    }
  }

  // Revoked entries leave the record whether or not they were still in the
  // file — a hand-removed entry is just as gone.
  const keptClaims = claimed.filter((entry) => !revoke.includes(entry));
  const nextClaimed =
    merged.added === undefined || keptClaims.includes(merged.added)
      ? keptClaims
      : [...keptClaims, merged.added];
  if (
    nextClaimed.length === claimed.length &&
    nextClaimed.every((entry, index) => entry === claimed[index])
  ) {
    return;
  }
  if (nextClaimed.length === 0) {
    yield* fileSystem.remove(provenancePath).pipe(Effect.ignore);
    return;
  }
  yield* writeFileStringAtomically({
    filePath: provenancePath,
    contents: serializeHermesWorktreeTrustProvenance(nextClaimed),
  }).pipe(
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.logWarning("Failed to record Hermes worktree-trust provenance.", {
        provenancePath,
        cause: Cause.pretty(cause),
      }),
    ),
  );
});
