/**
 * HermesSkills — filesystem discovery of Hermes skills for the `$` picker.
 *
 * Hermes implements the [agentskills.io](https://agentskills.io) layout: one
 * directory per skill holding a `SKILL.md` with YAML frontmatter. Skills load
 * from `<HERMES_HOME>/skills` (user scope) and, for a project the user has
 * marked trusted with `hermes skills trust`, from `<cwd>/.hermes/skills` and
 * `<cwd>/.agents/skills` (project scope). Later roots win on name collisions.
 *
 * Discovery scans rather than asking the CLI, unlike the Grok driver. Hermes'
 * `hermes skills list` prints a table with no `--json` flag, and parsing a
 * table that exists for humans would break on the next release; the on-disk
 * layout is the stable contract. The tradeoff is that a skill disabled in
 * `config.yaml` still appears — the scan cannot see Hermes' enable/disable
 * state — which is why every discovered entry is reported as `enabled` and
 * the picker treats the list as "installed", not "active".
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

/**
 * Enumerate Hermes skills from the resolved Hermes home and, when a workspace
 * is known, the two project-scoped roots. Discovery is best-effort: an
 * unreadable root or a skill with malformed frontmatter is skipped so a broken
 * skill never degrades the provider snapshot. On name collisions later roots
 * win — project skills shadow user skills, matching Hermes' own resolution.
 */
export const discoverHermesSkills = Effect.fn("discoverHermesSkills")(function* (
  config: Pick<HermesSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hermesHomePath = yield* resolveHermesHomePath(config, environment, cwd);

  const roots: ReadonlyArray<{ directory: string; scope: HermesSkillScope }> = [
    { directory: path.join(hermesHomePath, "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".hermes", "skills"), scope: "project" as const },
        ]
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      // Hermes writes bookkeeping files beside the skill directories — the
      // `.bundled_manifest` sync record and the `.no-bundled-skills` opt-out
      // marker both live directly under `<home>/skills`. Neither has a
      // `SKILL.md`, so the read below already skips them; the explicit guard
      // keeps a dotfile from ever becoming a skill name.
      if (entry.startsWith(".")) {
        continue;
      }

      const skillPath = path.join(root.directory, entry, "SKILL.md");
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

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
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
