/**
 * HermesSkillState — ask Hermes which of the discovered skills will actually
 * load, and annotate the scan's results with the answer.
 *
 * `./HermesSkills.ts` owns *existence*: it walks the skill roots because that
 * is the only place a `SKILL.md` path can come from, and `ServerProviderSkill`
 * requires one. It cannot own *eligibility*, because Hermes decides that with
 * information the filesystem does not carry. `hermes skills list
 * --enabled-only` runs `tools/skills_tool.py:_find_all_skills`, which in a
 * single pass applies:
 *
 * - the config denylists — `skills.disabled` and
 *   `skills.platform_disabled.<platform>`, minus the skills Hermes refuses to
 *   let anyone disable (`agent/skill_utils.py:get_disabled_skill_names`);
 * - the `platforms:` host-OS gate and the `environments:` relevance gate
 *   (`tools/skills_tool.py:211`);
 * - the trusted-project gate **and the fail-closed security quarantine**, via
 *   `iter_project_skill_files` — the comment at `tools/skills_tool.py:203`
 *   calls it "the quarantine chokepoint". This is the one that cannot be
 *   reimplemented here at any price: it runs Hermes' own scanner.
 *
 * **Which is why this is an annotation and not a source.** The table rows
 * carry `{name, category, source, trust}` and no path, so a name the CLI
 * reports that the scan did not find is dropped — there is nothing to build a
 * `ServerProviderSkill` from. The scan stays authoritative for what exists;
 * the CLI decides `enabled` and enriches `scope`.
 *
 * **Parsing a human table, safely.** `hermes skills list` has no `--json`
 * (only `skills search` and `skills list-modified` do), so the Rich table is
 * the only surface. Two properties make it tractable, and one makes it
 * dangerous:
 *
 * - piped output is not a terminal, so Rich emits no ANSI at all and the
 *   `Status` cell arrives as a plain `enabled` / `disabled`;
 * - body rows are delimited by `│` while the `box.HEAVY_HEAD` header uses
 *   `┃`, so the header never looks like data;
 * - but Rich falls back to **80 columns** when it cannot see a terminal, and
 *   at 80 columns a long skill name is silently ellipsis-truncated. A
 *   truncated name would match nothing and quietly disable a working skill.
 *   {@link HERMES_SKILLS_LIST_COLUMNS} is exported into the child environment
 *   to prevent that, and {@link parseHermesSkillsListTable} refuses the whole
 *   output if it sees an ellipsis anyway.
 *
 * **Fail-open is the contract.** A spawn failure, a timeout, an older Hermes
 * that rejects `--enabled-only`, an unparseable table, or a truncated one all
 * yield `undefined`, and the caller then leaves every scanned skill
 * `enabled: true` — the behaviour before this module existed. The annotation
 * may never be the reason a user's picker is empty.
 *
 * @module provider/Drivers/HermesSkillState
 */
import type { HermesSettings, ServerProviderSkill } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

/**
 * Width handed to Rich so no cell is ellipsized. Rich honours `COLUMNS` even
 * when stdout is not a terminal, and `Table` sizes to content rather than
 * expanding, so an oversized value costs nothing but removes the truncation
 * class of bug entirely.
 */
export const HERMES_SKILLS_LIST_COLUMNS = "400";

const HERMES_SKILLS_LIST_TIMEOUT_MS = 20_000;

/** Rich's ellipsis character, used when a cell is too narrow for its content. */
const ELLIPSIS = "…";

export interface HermesSkillListingRow {
  readonly name: string;
  readonly category: string | undefined;
  readonly source: string | undefined;
  readonly trust: string | undefined;
}

/**
 * Parse the body rows of `hermes skills list --enabled-only`.
 *
 * Returns `undefined` — meaning "fail open, trust nothing here" — when the
 * output contains an ellipsis (a cell was truncated, so names are unreliable)
 * or when no row parsed at all while the output was plainly non-empty. An
 * empty skills tree legitimately produces zero rows, so the caller
 * distinguishes "no rows" from "could not read" by the exit code, not by this
 * function alone.
 *
 * Exported for tests: the table shape is the fragile part of this module and
 * is far cheaper to assert on with captured fixtures than through a spawn.
 */
export function parseHermesSkillsListTable(
  stdout: string,
): ReadonlyArray<HermesSkillListingRow> | undefined {
  if (stdout.includes(ELLIPSIS)) {
    return undefined;
  }

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
    const [, name, category, source, trust] = cells.map((cell) => cell.trim());
    if (!name || name === "Name") {
      continue;
    }
    rows.push({
      name,
      category: category || undefined,
      source: source || undefined,
      trust: trust || undefined,
    });
  }

  return rows;
}

/**
 * Build the environment for the listing spawn.
 *
 * `COLUMNS` is the load-bearing one (see the module doc). `NO_COLOR` and a
 * dumb `TERM` are belt-and-braces: Rich already drops styling for a
 * non-terminal stdout, but a future Hermes that forces colour, or a user with
 * `FORCE_COLOR` exported in their shell, would otherwise reach the parser as
 * ANSI-wrapped cells. The caller's environment is spread first so a
 * per-instance variable configured in Settings still wins over the process
 * environment, and only these presentation keys are imposed.
 *
 * **`HERMES_PLATFORM` is deliberately not set**, here or on the `hermes acp`
 * spawn. It looks like a host-OS selector and is not: it names a gateway
 * *channel* (`cli`, `discord`, a webhook), and the host-OS gate is the
 * `platforms:` frontmatter key Hermes evaluates against `sys.platform` on its
 * own. Hermes' own ACP adapter never sets it, so `skills.platform_disabled`
 * does not apply to an ACP session upstream either, and matching that is the
 * point. Inventing a value would also be actively harmful: an unrecognised
 * surface is classified as a human messaging channel
 * (`gateway/session_context.py:NON_MESSAGING_SESSION_SURFACES` is
 * default-deny), which silently turns `agent.verify_on_stop: auto` off for
 * every T3 session. A user who wants `platform_disabled` to apply can set the
 * variable under Settings → Providers → Hermes → Environment variables;
 * `mergeProviderInstanceEnvironment` already folds that into the environment
 * both this listing and the session spawn receive.
 */
export function buildHermesSkillsListEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    COLUMNS: HERMES_SKILLS_LIST_COLUMNS,
    NO_COLOR: "1",
    TERM: "dumb",
    FORCE_COLOR: "0",
  };
}

/**
 * Ask Hermes for the names it will actually load, or `undefined` when it
 * could not be asked. Never fails.
 */
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
      // An older Hermes rejects `--enabled-only` with a usage error, and a
      // profile with no skills directory can also exit non-zero. Neither is a
      // reason to disable anything.
      yield* Effect.logDebug("`hermes skills list --enabled-only` exited non-zero.", {
        exitCode: output.code,
      });
      return undefined;
    }

    const rows = parseHermesSkillsListTable(output.stdout);
    if (rows === undefined) {
      yield* Effect.logWarning(
        "Could not parse `hermes skills list --enabled-only` output; treating every discovered skill as enabled.",
      );
      return undefined;
    }
    return rows;
  },
);

/**
 * Apply a listing to the scan's results.
 *
 * A scanned skill the listing names stays `enabled` and picks up the
 * listing's `category` as its scope hint when the scan had none; one the
 * listing omits becomes `enabled: false`, so the `$` picker and the slash
 * menu hide it (both filter on `enabled` —
 * `packages/client-runtime/src/providerSkills.ts` and
 * `apps/web/src/providerSkillSearch.ts`) while the entry stays in the
 * snapshot for anything that wants to show installed-but-inactive skills.
 *
 * Two fail-open guards, in order of likelihood:
 *
 * - `rows === undefined` — the listing could not be read. Return the scan
 *   untouched.
 * - `rows` is empty while the scan found skills. Hermes reporting zero
 *   enabled skills for a non-empty tree is possible (everything disabled) but
 *   is indistinguishable from a renderer change that broke the parser, and the
 *   two differ enormously in cost: the first is a cosmetic over-report, the
 *   second empties the picker. Treat it as unreadable.
 */
export function annotateHermesSkillsWithEnableState(
  skills: ReadonlyArray<ServerProviderSkill>,
  rows: ReadonlyArray<HermesSkillListingRow> | undefined,
): ReadonlyArray<ServerProviderSkill> {
  if (rows === undefined) {
    return skills;
  }
  if (rows.length === 0 && skills.length > 0) {
    return skills;
  }

  const byName = new Map(rows.map((row) => [row.name, row] as const));
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
