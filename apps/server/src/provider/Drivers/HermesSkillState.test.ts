import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ServerProviderSkill } from "@t3tools/contracts";

import {
  annotateHermesSkillsWithEnableState,
  buildHermesSkillsListEnvironment,
  discoverHermesEnabledSkillNames,
  HERMES_SKILLS_LIST_COLUMNS,
  parseHermesSkillsListTable,
} from "./HermesSkillState.ts";

/**
 * Captured from Rich itself, rendered exactly as `hermes skills list
 * --enabled-only` renders it: `box.HEAVY_HEAD`, no ANSI (stdout is not a
 * terminal), a title line above and a summary line below.
 */
const WIDE_TABLE = [
  "                Installed Skills (enabled only)                ",
  "┏━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━━━┳━━━━━━━━━┓",
  "┃ Name         ┃ Category     ┃ Source  ┃ Trust     ┃ Status  ┃",
  "┡━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━━━╇━━━━━━━━━┩",
  "│ pdf          │ productivity │ builtin │ builtin   │ enabled │",
  "│ team-runbook │ ops          │ hub     │ community │ enabled │",
  "│ arxiv        │ research     │ builtin │ builtin   │ enabled │",
  "└──────────────┴──────────────┴─────────┴───────────┴─────────┘",
  "2 hub-installed, 1 builtin, 0 local — 3 enabled shown",
  "",
].join("\n");

/**
 * The same command at Rich's non-terminal fallback of 80 columns, with real
 * skill names from a live install. Two names are ellipsized and one is not.
 *
 * This is the output that actually reached us in the field: `TERM=dumb` plus
 * `FORCE_COLOR=0` made Rich believe it was writing to a dumb terminal, and
 * `Console.size` short-circuits to `(80, 25)` for one of those *before* it
 * reads `COLUMNS`. `buildHermesSkillsListEnvironment` no longer sets either
 * key, but the parser still has to cope, because a width surprise must degrade
 * rather than silently disable a working skill.
 */
const TRUNCATED_TABLE = [
  "                        Installed Skills (enabled only)                         ",
  "┏━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┓",
  "┃ Name                    ┃ Category             ┃ Source  ┃ Trust   ┃ Status  ┃",
  "┡━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━┩",
  "│ airflow-dags-repo-conv… │ software-development │ local   │ local   │ enabled │",
  "│ inspecting-hermes-desk… │ software-development │ builtin │ builtin │ enabled │",
  "│ pdf                     │ productivity         │ builtin │ builtin │ enabled │",
  "└─────────────────────────┴──────────────────────┴─────────┴─────────┴─────────┘",
  "2 hub-installed, 53 builtin, 4 local — 59 enabled shown",
  "",
].join("\n");

const EMPTY_TABLE = [
  "         Installed Skills (enabled only)          ",
  "┏━━━━━━┳━━━━━━━━━━┳━━━━━━━━┳━━━━━━━┳━━━━━━━━┓",
  "┃ Name ┃ Category ┃ Source ┃ Trust ┃ Status ┃",
  "┡━━━━━━╇━━━━━━━━━━╇━━━━━━━━╇━━━━━━━╇━━━━━━━━┩",
  "└──────┴──────────┴────────┴───────┴────────┘",
  "0 hub-installed, 0 builtin, 0 local — 0 enabled shown",
  "",
].join("\n");

const skill = (
  name: string,
  overrides: Partial<ServerProviderSkill> = {},
): ServerProviderSkill => ({
  name,
  path: `/home/u/.hermes/skills/cat/${name}/SKILL.md`,
  enabled: true,
  ...overrides,
});

describe("parseHermesSkillsListTable", () => {
  it("reads the body rows and ignores the title, header, rules and summary", () => {
    assert.deepStrictEqual(
      [...parseHermesSkillsListTable(WIDE_TABLE)],
      [
        {
          name: "pdf",
          nameIsTruncated: false,
          category: "productivity",
          source: "builtin",
          trust: "builtin",
        },
        {
          name: "team-runbook",
          nameIsTruncated: false,
          category: "ops",
          source: "hub",
          trust: "community",
        },
        {
          name: "arxiv",
          nameIsTruncated: false,
          category: "research",
          source: "builtin",
          trust: "builtin",
        },
      ],
    );
  });

  it("flags an ellipsized name and strips the ellipsis", () => {
    const rows = parseHermesSkillsListTable(TRUNCATED_TABLE);
    assert.deepStrictEqual(
      rows.map((row) => ({ name: row.name, nameIsTruncated: row.nameIsTruncated })),
      [
        { name: "airflow-dags-repo-conv", nameIsTruncated: true },
        { name: "inspecting-hermes-desk", nameIsTruncated: true },
        { name: "pdf", nameIsTruncated: false },
      ],
    );
  });

  it("returns no rows for an empty catalog", () => {
    assert.deepStrictEqual([...parseHermesSkillsListTable(EMPTY_TABLE)], []);
  });

  it("returns no rows for output that is not a table at all", () => {
    assert.deepStrictEqual(
      [...parseHermesSkillsListTable("usage: hermes skills list [-h]\nerror: bad flag")],
      [],
    );
  });
});

describe("buildHermesSkillsListEnvironment", () => {
  it("pins the render width so Rich cannot ellipsize a name", () => {
    const env = buildHermesSkillsListEnvironment({ HERMES_HOME: "/home/u/.hermes" });
    assert.equal(env.COLUMNS, HERMES_SKILLS_LIST_COLUMNS);
    assert.equal(env.HERMES_HOME, "/home/u/.hermes");
  });

  it("never sets TERM or FORCE_COLOR, which would pin the width back to 80", () => {
    // Rich's `Console.size` returns a hardcoded (80, 25) for a dumb terminal
    // *before* reading COLUMNS, and `is_terminal` treats FORCE_COLOR as
    // presence-based (`force_color != ""`), so even "0" reads as a terminal.
    // Setting both — which looks like belt-and-braces colour suppression —
    // truncates every long skill name. This is the regression guard.
    const env = buildHermesSkillsListEnvironment({});
    assert.isUndefined(env.TERM);
    assert.isUndefined(env.FORCE_COLOR);
  });

  it("clears an inherited FORCE_COLOR or dumb TERM from the caller's shell", () => {
    const env = buildHermesSkillsListEnvironment({ FORCE_COLOR: "3", TERM: "dumb" });
    assert.isUndefined(env.FORCE_COLOR);
    assert.isUndefined(env.TERM);
  });

  it("suppresses colour without touching width", () => {
    const env = buildHermesSkillsListEnvironment({});
    assert.equal(env.NO_COLOR, "1");
    assert.equal(env.TTY_COMPATIBLE, "0");
  });
});

describe("annotateHermesSkillsWithEnableState", () => {
  it("disables a scanned skill the listing omits", () => {
    const annotated = annotateHermesSkillsWithEnableState(
      [skill("pdf"), skill("noisy-skill")],
      parseHermesSkillsListTable(WIDE_TABLE),
    );
    assert.deepStrictEqual(
      annotated?.map((entry) => ({ name: entry.name, enabled: entry.enabled })),
      [
        { name: "pdf", enabled: true },
        { name: "noisy-skill", enabled: false },
      ],
    );
  });

  it("resolves an ellipsized name against a unique scanned prefix", () => {
    const annotated = annotateHermesSkillsWithEnableState(
      [
        skill("airflow-dags-repo-conventions"),
        skill("inspecting-hermes-desktop-dom"),
        skill("pdf"),
        skill("turned-off"),
      ],
      parseHermesSkillsListTable(TRUNCATED_TABLE),
    );
    assert.deepStrictEqual(
      annotated?.map((entry) => ({ name: entry.name, enabled: entry.enabled })),
      [
        { name: "airflow-dags-repo-conventions", enabled: true },
        { name: "inspecting-hermes-desktop-dom", enabled: true },
        { name: "pdf", enabled: true },
        { name: "turned-off", enabled: false },
      ],
    );
  });

  it("refuses the listing when a truncated prefix is ambiguous", () => {
    // Two scanned skills share the visible prefix, so either choice could
    // disable a working skill. Fail open instead of guessing.
    assert.isUndefined(
      annotateHermesSkillsWithEnableState(
        [skill("airflow-dags-repo-conventions"), skill("airflow-dags-repo-conventions-v2")],
        parseHermesSkillsListTable(TRUNCATED_TABLE),
      ),
    );
  });

  it("refuses the listing when a truncated prefix matches nothing", () => {
    assert.isUndefined(
      annotateHermesSkillsWithEnableState(
        [skill("pdf")],
        parseHermesSkillsListTable(TRUNCATED_TABLE),
      ),
    );
  });

  it("fills a missing scope from the listing's category", () => {
    const annotated = annotateHermesSkillsWithEnableState(
      [skill("pdf"), skill("arxiv")],
      parseHermesSkillsListTable(WIDE_TABLE),
    );
    assert.equal(annotated?.[0]?.scope, "productivity");
    assert.equal(annotated?.[1]?.scope, "research");
  });

  it("never overwrites a scope the scan already established", () => {
    // Project vs user is a trust distinction the picker's source badge reads;
    // a category is only a grouping hint and must not clobber it.
    const annotated = annotateHermesSkillsWithEnableState(
      [skill("pdf", { scope: "project" })],
      parseHermesSkillsListTable(WIDE_TABLE),
    );
    assert.equal(annotated?.[0]?.scope, "project");
  });

  it("refuses when the listing could not be read", () => {
    assert.isUndefined(annotateHermesSkillsWithEnableState([skill("pdf")], undefined));
  });

  it("refuses an empty listing when the scan found skills", () => {
    // Everything-disabled and parser-broke are indistinguishable here, and
    // they differ enormously in cost: a cosmetic over-report versus an empty
    // picker. Fail open.
    assert.isUndefined(annotateHermesSkillsWithEnableState([skill("pdf")], []));
  });

  it("accepts an empty listing when the scan found nothing either", () => {
    assert.deepStrictEqual([...(annotateHermesSkillsWithEnableState([], []) ?? [])], []);
  });
});

/**
 * A fake `hermes` that behaves like Rich: it renders wide only when the
 * environment actually lets Rich see a wide console, and falls back to the
 * 80-column truncated form otherwise.
 *
 * This is the test that was missing. The unit tests above covered the parser
 * against both fixtures and the env builder's keys, but nothing checked the
 * two together — so an env that looked like belt-and-braces colour
 * suppression silently pinned Rich to 80 columns in the field while every
 * test stayed green.
 */
const fakeHermesSpawner = (recorded: {
  env?: Record<string, string | undefined>;
  cwd?: string | undefined;
}) =>
  ChildProcessSpawner.make((command) => {
    const options = command._tag === "StandardCommand" ? command.options : undefined;
    const env = (options?.env ?? {}) as Record<string, string | undefined>;
    recorded.env = env;
    recorded.cwd = options?.cwd;

    // Rich: `is_terminal` is true when FORCE_COLOR is present and non-empty,
    // and a dumb TERM on a "terminal" short-circuits the width to 80 before
    // COLUMNS is read.
    const forceColor = env.FORCE_COLOR;
    const isTerminal =
      env.TTY_COMPATIBLE === "1" ||
      (env.TTY_COMPATIBLE !== "0" && forceColor !== undefined && forceColor !== "");
    const isDumb = isTerminal && ["dumb", "unknown"].includes((env.TERM ?? "").toLowerCase());
    const columns = isDumb ? 80 : Number.parseInt(env.COLUMNS ?? "80", 10);

    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(columns >= 120 ? WIDE_REAL_TABLE : TRUNCATED_TABLE)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

/** The same three skills as {@link TRUNCATED_TABLE}, rendered with room. */
const WIDE_REAL_TABLE = [
  "                           Installed Skills (enabled only)                            ",
  "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┓",
  "┃ Name                          ┃ Category             ┃ Source  ┃ Trust   ┃ Status  ┃",
  "┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━┩",
  "│ airflow-dags-repo-conventions │ software-development │ local   │ local   │ enabled │",
  "│ inspecting-hermes-desktop-dom │ software-development │ builtin │ builtin │ enabled │",
  "│ pdf                           │ productivity         │ builtin │ builtin │ enabled │",
  "└───────────────────────────────┴──────────────────────┴─────────┴─────────┴─────────┘",
  "2 hub-installed, 53 builtin, 4 local — 59 enabled shown",
  "",
].join("\n");

describe("discoverHermesEnabledSkillNames", () => {
  it.effect("gets untruncated names through the real spawn path", () => {
    const recorded: { env?: Record<string, string | undefined>; cwd?: string | undefined } = {};
    return Effect.gen(function* () {
      const rows = yield* discoverHermesEnabledSkillNames(
        { binaryPath: "hermes" },
        // A shell that exports both of the keys that used to break this.
        { FORCE_COLOR: "1", TERM: "dumb", HERMES_HOME: "/home/u/.hermes" },
        "/workspaces/demo",
      ).pipe(
        Effect.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeHermesSpawner(recorded)),
        ),
      );

      assert.deepStrictEqual(
        rows?.map((row) => ({ name: row.name, nameIsTruncated: row.nameIsTruncated })),
        [
          { name: "airflow-dags-repo-conventions", nameIsTruncated: false },
          { name: "inspecting-hermes-desktop-dom", nameIsTruncated: false },
          { name: "pdf", nameIsTruncated: false },
        ],
      );
      // The listing must run in the workspace: project-scoped skills and the
      // trusted-project gate both hang off cwd.
      assert.equal(recorded.cwd, "/workspaces/demo");
      assert.equal(recorded.env?.HERMES_HOME, "/home/u/.hermes");
    });
  });

  it.effect("annotates end to end without falling open", () => {
    const recorded: { env?: Record<string, string | undefined>; cwd?: string | undefined } = {};
    return Effect.gen(function* () {
      const rows = yield* discoverHermesEnabledSkillNames(
        { binaryPath: "hermes" },
        {},
        undefined,
      ).pipe(
        Effect.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeHermesSpawner(recorded)),
        ),
      );
      const annotated = annotateHermesSkillsWithEnableState(
        [
          skill("airflow-dags-repo-conventions"),
          skill("inspecting-hermes-desktop-dom"),
          skill("pdf"),
          skill("turned-off"),
        ],
        rows,
      );
      assert.deepStrictEqual(
        annotated?.map((entry) => ({ name: entry.name, enabled: entry.enabled })),
        [
          { name: "airflow-dags-repo-conventions", enabled: true },
          { name: "inspecting-hermes-desktop-dom", enabled: true },
          { name: "pdf", enabled: true },
          { name: "turned-off", enabled: false },
        ],
      );
    });
  });
});
