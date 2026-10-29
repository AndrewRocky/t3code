import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument, stringify as stringifyYamlDocument } from "yaml";

import type { HermesSettings } from "../settings.ts";
import { expandHermesConfigPath, resolveHermesHomePath, withHermesConfigLock } from "./home.ts";
import { findHermesProjectRoot } from "./skills.ts";

// Hermes loads project skills only for roots in `skills.trusted_project_dirs`, so
// a linked worktree starts untrusted. T3 adds a worktree whose main checkout is
// trusted and revokes only its own entries (gone worktrees, or all when off).

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
 * The main checkout of the linked worktree at `projectRoot`, read from git's
 * on-disk layout: only a worktree gitdir has `commondir`, so submodules and
 * worktrees of bare repositories return `undefined`.
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
 * Applies one addition and some removals to `skills.trusted_project_dirs`.
 * `undefined` leaves the file alone when its shape is not one T3 wrote; empty
 * lists and an empty `skills` mapping are dropped.
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
 * Aligns the trust list with {@link HermesSettings.trustWorktreesOfTrustedProjects}
 * for `cwd`. Best-effort: an unexpected `config.yaml` is left alone with a
 * warning, and a session start never fails because of it.
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
  const homeDirectory = yield* HostProcess.HomeDirectory;
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
      const expanded = expandHermesConfigPath(entry, input.environment, homeDirectory);
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
