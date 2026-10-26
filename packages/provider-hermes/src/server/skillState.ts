import type { ServerProviderSkill } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { HermesSettings } from "../settings.ts";

// `skills.ts` owns existence (only the scan has paths); Hermes owns
// eligibility. `hermes skills list --enabled-only` applies the config
// denylists, the `platforms:`/`environments:` gates and the trusted-project
// security quarantine, which cannot be reimplemented here. The listing has no
// `--json`, so its Rich table is parsed, and every failure is fail-open: the
// annotation may never be the reason the picker is empty.

/**
 * Rich falls back to 80 columns without a terminal and then ellipsizes long
 * names; a truncated name would silently disable a working skill.
 */
export const HERMES_SKILLS_LIST_COLUMNS = "400";

const HERMES_SKILLS_LIST_TIMEOUT_MS = 20_000;

const ELLIPSIS = "…";

export interface HermesSkillListingRow {
  /** A prefix of the real name when `nameIsTruncated` is set. */
  readonly name: string;
  readonly nameIsTruncated: boolean;
  readonly category: string | undefined;
  readonly source: string | undefined;
  readonly trust: string | undefined;
}

/**
 * Body rows use `│`, the `HEAVY_HEAD` header uses `┃`, so headers, rules and
 * the summary line fall away. A wrapped continuation line has an empty first
 * cell and is skipped. An empty result is legitimate (nothing enabled).
 */
export function parseHermesSkillsListTable(stdout: string): ReadonlyArray<HermesSkillListingRow> {
  const rows: Array<HermesSkillListingRow> = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("│")) {
      continue;
    }
    // `│ a │ b │ c │ d │ e │` splits to ["", " a ", … , " e ", ""].
    const cells = line.split("│");
    if (cells.length !== 7) {
      continue;
    }
    const [, rawName, category, source, trust] = cells.map((cell) => cell.trim());
    if (!rawName || rawName === "Name") {
      continue;
    }
    const nameIsTruncated = rawName.endsWith(ELLIPSIS);
    const name = nameIsTruncated ? rawName.slice(0, -ELLIPSIS.length).trim() : rawName;
    if (!name) {
      continue;
    }
    rows.push({
      name,
      nameIsTruncated,
      category: category || undefined,
      source: source || undefined,
      trust: trust || undefined,
    });
  }

  return rows;
}

/**
 * `TERM=dumb` and any `FORCE_COLOR` (presence-based, even `0`) make Rich treat
 * stdout as a dumb terminal and pin the width to 80 before it reads `COLUMNS`,
 * so they are removed, not overridden. `HERMES_PLATFORM` is deliberately not
 * set: it names a gateway channel, not the host OS.
 */
export function buildHermesSkillsListEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const listingEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    COLUMNS: HERMES_SKILLS_LIST_COLUMNS,
    NO_COLOR: "1",
    TTY_COMPATIBLE: "0",
  };
  delete listingEnvironment.FORCE_COLOR;
  delete listingEnvironment.TERM;
  return listingEnvironment;
}

/** The names Hermes will load, or `undefined` when it could not be asked. Never fails. */
export const discoverHermesEnabledSkillNames = Effect.fn("discoverHermesEnabledSkillNames")(
  function* (
    config: Pick<HermesSettings, "binaryPath">,
    environment: NodeJS.ProcessEnv = process.env,
    cwd?: string,
  ): Effect.fn.Return<
    ReadonlyArray<HermesSkillListingRow> | undefined,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    const command = config.binaryPath || "hermes";
    const listingEnvironment = buildHermesSkillsListEnvironment(environment);

    const result = yield* Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(
        command,
        ["skills", "list", "--enabled-only"],
        { env: listingEnvironment },
      );
      return yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(cwd ? { cwd } : {}),
          env: listingEnvironment,
          shell: spawnCommand.shell,
        }),
      );
    }).pipe(
      Effect.timeoutOption(HERMES_SKILLS_LIST_TIMEOUT_MS),
      Effect.orElseSucceed(() => undefined),
    );

    if (result === undefined || Option.isNone(result)) {
      yield* Effect.logDebug(
        "Hermes skill enable-state listing did not complete; treating every discovered skill as enabled.",
      );
      return undefined;
    }

    const output = result.value;
    if (output.code !== 0) {
      // A Hermes without `--enabled-only`, or a profile with no skills directory.
      yield* Effect.logDebug("`hermes skills list --enabled-only` exited non-zero.", {
        exitCode: output.code,
      });
      return undefined;
    }

    return parseHermesSkillsListTable(output.stdout);
  },
);

/**
 * A scanned skill the listing omits becomes `enabled: false` (the picker hides
 * it). Returns `undefined`, meaning "leave everything enabled", when the
 * listing is missing, empty for a non-empty scan (indistinguishable from a
 * renderer change that broke the parser), or has a truncated name that does
 * not resolve to exactly one scanned skill.
 */
export function annotateHermesSkillsWithEnableState(
  skills: ReadonlyArray<ServerProviderSkill>,
  rows: ReadonlyArray<HermesSkillListingRow> | undefined,
): ReadonlyArray<ServerProviderSkill> | undefined {
  if (rows === undefined) {
    return undefined;
  }
  if (rows.length === 0) {
    return skills.length === 0 ? skills : undefined;
  }

  const byName = new Map<string, HermesSkillListingRow>();
  for (const row of rows) {
    if (row.nameIsTruncated) {
      const candidates = skills.filter((skill) => skill.name.startsWith(row.name));
      const resolved = candidates.length === 1 ? candidates[0] : undefined;
      if (resolved === undefined) {
        return undefined;
      }
      byName.set(resolved.name, row);
      continue;
    }
    byName.set(row.name, row);
  }

  return skills.map((skill) => {
    const row = byName.get(skill.name);
    if (row === undefined) {
      return { ...skill, enabled: false };
    }
    return {
      ...skill,
      enabled: true,
      ...(skill.scope === undefined && row.category ? { scope: row.category } : {}),
    };
  });
}
