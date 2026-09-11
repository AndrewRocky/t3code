/**
 * HermesSkills — filesystem discovery of Hermes skills for the `$` picker.
 *
 * Hermes implements the [agentskills.io](https://agentskills.io) layout: one
 * directory per skill holding a `SKILL.md` with YAML frontmatter. What the
 * layout does *not* promise is that those directories sit at the top of the
 * tree. Hermes installs every bundled skill under a category directory —
 * `tools/skills_sync.py:_compute_relative_dest` is explicit about it
 * ("Destination preserving category structure (bundled/mlops/axolotl ->
 * skills/mlops/axolotl)"), and `tools/skills_tool.py:_get_category_from_path`
 * reads the category back out by requiring at least three path components
 * below the skills root. So the real on-disk shape is
 * `<root>/<category>/<skill>/SKILL.md`, and Hermes' own scan
 * (`agent/skill_utils.py:iter_skill_index_files`) is a full recursive walk.
 *
 * Discovery scans rather than asking the CLI for the *catalog*, unlike the
 * Grok driver: `hermes skills list` prints a Rich table with no `--json`
 * flag, and parsing a table that exists for humans would break on the next
 * release, while the on-disk layout is the stable contract. The CLI is still
 * consulted for enable/disable state, where it is the only source of truth —
 * see `./HermesSkillState.ts`.
 *
 * Precedence is Hermes' own, and it is **first-wins**
 * (`agent/skill_utils.py:get_scan_ordered_skills_dirs`): trusted project dirs,
 * then the profile-local root, then `skills.create_dir`, then
 * `skills.external_dirs`. Sorting the collected paths before resolving names
 * mirrors `iter_skill_index_files`, which yields `sorted(matches)`.
 *
 * Known over-report: Hermes loads project-scoped skills only for a git root
 * the user has marked trusted with `hermes skills trust`, and quarantines any
 * that fail its security scan (`agent/skill_utils.py:460-558`). Neither gate
 * is reproducible from here — the scan cannot run Hermes' scanner — so a
 * project skill may be listed that Hermes would refuse to load. The
 * `--enabled-only` annotation in `./HermesSkillState.ts` closes this whenever
 * the CLI is reachable, because that path runs inside Hermes' own quarantine
 * chokepoint.
 *
 * @module provider/Drivers/HermesSkills
 */
import type { HermesSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { resolveHermesHomePath } from "./HermesHome.ts";

type HermesSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Directories Hermes refuses to treat as skill trees at any depth
 * (`agent/skill_utils.py:EXCLUDED_SKILL_DIRS`). A skills root that happens to
 * live inside a checkout would otherwise drag a whole virtualenv into the
 * picker.
 */
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

/**
 * Progressive-disclosure payload directories inside a skill package
 * (`agent/skill_utils.py:SKILL_SUPPORT_DIRS`). Hermes prunes these only when
 * the directory holding them is itself a skill root, and loads their contents
 * on demand via `skill_view(name, file_path=...)` — they are never skills in
 * their own right.
 */
const SKILL_SUPPORT_DIRECTORIES: ReadonlySet<string> = new Set([
  "references",
  "templates",
  "assets",
  "scripts",
]);

/** Org-mirror directory and the token marker that gates it (`skill_utils.py:36-43`). */
const ORG_MIRROR_DIRECTORY = "_org";
const ORG_ACTIVE_MARKER = ".active_org";

/**
 * Depth ceiling for the walk, counted in directories below a root.
 *
 * Hermes' own walk is unbounded. The deepest layout it actually ships is
 * three directories below the root (`<category>/<skill>/<nested>/SKILL.md` in
 * `optional-skills`), so six leaves generous headroom for a hand-organised
 * tree while keeping a symlink cycle — `os.walk(followlinks=True)` upstream,
 * and `stat` follows links here too — from turning provider refresh into an
 * unbounded traversal.
 */
const MAX_SCAN_DEPTH = 6;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

/**
 * Parse a `SKILL.md` frontmatter block. Exported for focused tests: the three
 * outcomes drive different behaviour in the scan below, and each is much
 * cheaper to assert on directly than through a temp-directory fixture.
 */
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

function asStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
}

/**
 * Extra skill roots a Hermes profile can declare.
 *
 * `skills.external_dirs` and `skills.create_dir` are resolved the way
 * `agent/skill_utils.py:332-378` resolves them: `~` expanded, and a relative
 * value taken as relative to the Hermes home rather than the workspace.
 * Exported for tests; a missing or malformed `config.yaml` yields no extra
 * roots rather than failing discovery.
 */
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

function expandTilde(value: string, homeDirectory: string): string {
  if (value === "~") {
    return homeDirectory;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return `${homeDirectory}/${value.slice(2)}`;
  }
  return value;
}

/**
 * Collect every `SKILL.md` beneath `root`, mirroring
 * `agent/skill_utils.py:iter_skill_index_files`.
 *
 * The two subtleties are both upstream's: a directory that *is* a skill still
 * gets descended into (only its support directories are pruned, so a skill
 * package can nest further skills), and the org mirror resolves only for the
 * org named by `_org/.active_org`, so leaving an org stops its skills loading
 * without anyone cleaning the directory up.
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
    // Breadth-first over sorted children. Order does not decide precedence —
    // the collected paths are sorted before names are resolved, exactly as
    // `iter_skill_index_files` yields `sorted(matches)` — but keeping the walk
    // deterministic makes a failure reproducible.
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
      // Hermes writes bookkeeping files beside the skill directories — the
      // `.bundled_manifest` sync record and the `.no-bundled-skills` opt-out
      // marker both live directly under `<home>/skills`. Neither has a
      // `SKILL.md`, so they would be skipped anyway; the explicit guard keeps
      // a dotfile from ever becoming a skill name, and keeps the walk out of
      // `.git` inside a hand-managed external root.
      if (entry.startsWith(".")) {
        continue;
      }
      if (EXCLUDED_SKILL_DIRECTORIES.has(entry)) {
        continue;
      }
      // Only pruned for a directory that is itself a skill root: elsewhere a
      // directory called `scripts` is just a directory, and may hold skills.
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
 * Enumerate Hermes skills from the resolved Hermes home, the profile's extra
 * roots, and — when a workspace is known — the two project-scoped roots.
 *
 * Discovery is best-effort: an unreadable root or a skill with malformed
 * frontmatter is skipped so a broken skill never degrades the provider
 * snapshot. Roots are listed in Hermes' precedence order and resolved
 * **first-wins**, so a project skill shadows a same-named user skill and a
 * user skill shadows one from an external root, matching Hermes' own
 * resolution.
 */
export const discoverHermesSkills = Effect.fn("discoverHermesSkills")(function* (
  config: Pick<HermesSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hermesHomePath = yield* resolveHermesHomePath(config, environment, cwd);

  const configRoots = yield* fileSystem
    .readFileString(path.join(hermesHomePath, "config.yaml"))
    .pipe(
      Effect.map(parseHermesSkillConfigRoots),
      Effect.orElseSucceed(() => ({ createDir: undefined, externalDirs: [] as const })),
    );
  const resolveConfiguredRoot = (value: string): string => {
    const expanded = expandTilde(value, hermesHomePath);
    return path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(hermesHomePath, expanded);
  };

  // Hermes' order, highest precedence first: project `.hermes` then
  // `.agents` (`PROJECT_SKILLS_SUBDIRS`), the profile-local root,
  // `skills.create_dir`, then each `skills.external_dirs` entry in the order
  // the user declared them (`get_all_skills_dirs`).
  const roots: ReadonlyArray<{ directory: string; scope: HermesSkillScope }> = [
    ...(cwd
      ? [
          { directory: path.join(cwd, ".hermes", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
        ]
      : []),
    { directory: path.join(hermesHomePath, "skills"), scope: "user" },
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
      // A `create_dir` or external root nested inside another configured root
      // would otherwise be walked twice.
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
      // Malformed frontmatter means the skill won't load in Hermes either —
      // skip it rather than surfacing a broken entry under its directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const directoryName = path.basename(path.dirname(skillPath));
      const name =
        (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? directoryName.trim();
      if (!name) {
        continue;
      }
      // First-wins, within and across roots.
      if (skillsByName.has(name)) {
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
