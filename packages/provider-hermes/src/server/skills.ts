import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import type { HermesSettings } from "../settings.ts";
import { expandHermesConfigPath, resolveHermesHomePath } from "./home.ts";

// Hermes implements the agentskills.io layout under category directories
// (`<root>/<category>/<skill>/SKILL.md`) and walks the whole tree
// (`agent/skill_utils.py:iter_skill_index_files`). `hermes skills list` has no
// `--json`, so the on-disk layout is the stable contract; enable state comes
// from the CLI in `skillState.ts`.

type HermesSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** `agent/skill_utils.py:EXCLUDED_SKILL_DIRS`, pruned at any depth. */
const EXCLUDED_SKILL_DIRECTORIES: ReadonlySet<string> = new Set([
  ".venv",
  "venv",
  "node_modules",
  "site-packages",
  "__pycache__",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

/** `SKILL_SUPPORT_DIRS`: payload directories of a skill, pruned only below a skill root. */
const SKILL_SUPPORT_DIRECTORIES: ReadonlySet<string> = new Set([
  "references",
  "templates",
  "assets",
  "scripts",
]);

const ORG_MIRROR_DIRECTORY = "_org";
const ORG_ACTIVE_MARKER = ".active_org";

/**
 * Hermes' walk is unbounded; the deepest layout it ships is three levels, and
 * a bound keeps a symlink cycle from making provider refresh unbounded.
 */
const MAX_SCAN_DEPTH = 6;

/** `skill_utils.py:_PROJECT_ROOT_MAX_DEPTH`. */
const PROJECT_ROOT_MAX_DEPTH = 64;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

export function parseHermesSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

/** A string or a list of strings, as `skill_utils.py:_config_str_list` reads one. */
function asStringArray(value: unknown): ReadonlyArray<string> {
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
}

/** `skills.create_dir` and `skills.external_dirs`; a broken `config.yaml` adds no roots. */
export function parseHermesSkillConfigRoots(configYaml: string): {
  readonly createDir: string | undefined;
  readonly externalDirs: ReadonlyArray<string>;
} {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(configYaml);
  } catch {
    return { createDir: undefined, externalDirs: [] };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { createDir: undefined, externalDirs: [] };
  }
  const skills = (parsed as Record<string, unknown>).skills;
  if (typeof skills !== "object" || skills === null) {
    return { createDir: undefined, externalDirs: [] };
  }
  const record = skills as Record<string, unknown>;
  const createDirRaw = typeof record.create_dir === "string" ? record.create_dir.trim() : "";
  return {
    createDir: createDirRaw.length > 0 ? createDirRaw : undefined,
    externalDirs: asStringArray(record.external_dirs),
  };
}

/**
 * `agent/skill_utils.py:find_project_root`: the nearest directory with a `.git`
 * (a file in a linked worktree), symlinks resolved. A checkout at the home
 * directory is not a project. Trust (`skills.trusted_project_dirs`) is matched
 * against this root, not the cwd.
 */
export const findHermesProjectRoot = Effect.fn("findHermesProjectRoot")(function* (
  start: string,
  homeDirectory?: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolveReal = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));

  const home = yield* resolveReal(homeDirectory ?? (yield* HostProcess.HomeDirectory));
  let current = yield* resolveReal(start);
  for (let depth = 0; depth < PROJECT_ROOT_MAX_DEPTH; depth++) {
    const hasGit = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasGit) {
      return current === home ? undefined : current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
});

/**
 * `iter_skill_index_files`: a skill directory is still descended into (only
 * its support directories are pruned), and the org mirror resolves only for
 * the org named by `_org/.active_org`.
 */
const collectSkillIndexPaths = Effect.fn("collectHermesSkillIndexPaths")(function* (
  root: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const activeOrg = yield* fileSystem
    .readFileString(path.join(root, ORG_MIRROR_DIRECTORY, ORG_ACTIVE_MARKER))
    .pipe(
      Effect.map((contents) => {
        const trimmed = contents.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }),
      Effect.orElseSucceed(() => undefined),
    );

  const found: Array<string> = [];
  const queue: Array<{ readonly directory: string; readonly depth: number }> = [
    { directory: root, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }

    const entries = yield* fileSystem
      .readDirectory(current.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    const hasSkillIndex = entries.includes("SKILL.md");
    if (hasSkillIndex) {
      found.push(path.join(current.directory, "SKILL.md"));
    }
    if (current.depth >= MAX_SCAN_DEPTH) {
      continue;
    }

    for (const entry of [...entries].sort()) {
      // Bookkeeping files (`.bundled_manifest`, `.no-bundled-skills`) and `.git` are never skills.
      if (entry.startsWith(".")) {
        continue;
      }
      if (EXCLUDED_SKILL_DIRECTORIES.has(entry)) {
        continue;
      }
      if (hasSkillIndex && SKILL_SUPPORT_DIRECTORIES.has(entry)) {
        continue;
      }
      if (entry === ORG_MIRROR_DIRECTORY && current.directory === root) {
        if (activeOrg === undefined) {
          continue;
        }
        queue.push({
          directory: path.join(current.directory, entry, activeOrg),
          depth: current.depth + 2,
        });
        continue;
      }

      const childPath = path.join(current.directory, entry);
      const info = yield* fileSystem.stat(childPath).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type !== "Directory") {
        continue;
      }
      queue.push({ directory: childPath, depth: current.depth + 1 });
    }
  }

  return found;
});

/**
 * Best effort: an unreadable root or malformed frontmatter is skipped. Roots
 * are resolved **first-wins** in Hermes' order
 * (`get_scan_ordered_skills_dirs`): project `.hermes` then `.agents`, the
 * profile root, `skills.create_dir`, then `skills.external_dirs`.
 *
 * Project skills may be over-reported: Hermes loads them only for a trusted
 * project and after its security scan. `skillState.ts` corrects that whenever
 * the CLI is reachable.
 */
export const discoverHermesSkills = Effect.fn("discoverHermesSkills")(function* (
  config: Pick<HermesSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const hermesHomePath = yield* resolveHermesHomePath(config, environment, cwd);

  const configRoots = yield* fileSystem
    .readFileString(path.join(hermesHomePath, "config.yaml"))
    .pipe(
      Effect.map(parseHermesSkillConfigRoots),
      Effect.orElseSucceed(() => ({ createDir: undefined, externalDirs: [] as const })),
    );
  // `_home_relative(_expand_path(entry))`: only a path still relative after
  // `~` and `$VAR` expansion is taken relative to the Hermes home.
  const resolveConfiguredRoot = (value: string): string =>
    path.resolve(hermesHomePath, expandHermesConfigPath(value, environment, homeDirectory));

  const userSkillsRoot = path.join(hermesHomePath, "skills");
  const projectRoot = cwd ? yield* findHermesProjectRoot(cwd, homeDirectory) : undefined;
  const projectRoots = projectRoot
    ? [path.join(projectRoot, ".hermes", "skills"), path.join(projectRoot, ".agents", "skills")]
        // A Hermes home kept inside the checkout is the profile's root, not a project root.
        .filter((directory) => path.resolve(directory) !== path.resolve(userSkillsRoot))
        .map((directory) => ({ directory, scope: "project" as const }))
    : [];
  const roots: ReadonlyArray<{ directory: string; scope: HermesSkillScope }> = [
    ...projectRoots,
    { directory: userSkillsRoot, scope: "user" },
    ...(configRoots.createDir
      ? [{ directory: resolveConfiguredRoot(configRoots.createDir), scope: "user" as const }]
      : []),
    ...configRoots.externalDirs.map((directory) => ({
      directory: resolveConfiguredRoot(directory),
      scope: "user" as const,
    })),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const seenPaths = new Set<string>();
  for (const root of roots) {
    const indexPaths = yield* collectSkillIndexPaths(root.directory);

    for (const skillPath of [...indexPaths].sort()) {
      // A configured root nested inside another would otherwise be walked twice.
      if (seenPaths.has(skillPath)) {
        continue;
      }
      seenPaths.add(skillPath);

      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseHermesSkillFrontmatter(contents);
      // Hermes would not load it either.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const directoryName = path.basename(path.dirname(skillPath));
      const name =
        (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? directoryName.trim();
      if (!name || skillsByName.has(name)) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
