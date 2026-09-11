import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import type { ServerProviderSkill } from "@t3tools/contracts";

import {
  annotateHermesSkillsWithEnableState,
  buildHermesSkillsListEnvironment,
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
 * The same command at Rich's non-terminal default of 80 columns: the name is
 * ellipsized and the `Trust` cell wraps onto a second line. This is the
 * output {@link HERMES_SKILLS_LIST_COLUMNS} exists to prevent, and which the
 * parser must refuse rather than half-read.
 */
const TRUNCATED_TABLE = [
  "                        Installed Skills (enabled only)                         ",
  "┏━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━┳━━━━━━━━┳━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━┓",
  "┃ Name              ┃ Category          ┃ Source ┃ Trust             ┃ Status  ┃",
  "┡━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━╇━━━━━━━━╇━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━┩",
  "│ a-very-long-skil… │ autonomous-ai-ag… │ hub    │ official (nous    │ enabled │",
  "│                   │                   │        │ research)         │         │",
  "└───────────────────┴───────────────────┴────────┴───────────────────┴─────────┘",
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
      [...(parseHermesSkillsListTable(WIDE_TABLE) ?? [])],
      [
        { name: "pdf", category: "productivity", source: "builtin", trust: "builtin" },
        { name: "team-runbook", category: "ops", source: "hub", trust: "community" },
        { name: "arxiv", category: "research", source: "builtin", trust: "builtin" },
      ],
    );
  });

  it("refuses output containing a truncated cell", () => {
    // Matching `a-very-long-skil…` against a scanned name would fail and
    // silently disable a working skill, so the whole listing is rejected and
    // the caller falls open.
    assert.isUndefined(parseHermesSkillsListTable(TRUNCATED_TABLE));
  });

  it("returns no rows for an empty catalog", () => {
    assert.deepStrictEqual([...(parseHermesSkillsListTable(EMPTY_TABLE) ?? [])], []);
  });

  it("returns no rows for output that is not a table at all", () => {
    assert.deepStrictEqual(
      [...(parseHermesSkillsListTable("usage: hermes skills list [-h]\nerror: bad flag") ?? [])],
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

  it("suppresses colour even when the caller's shell forces it", () => {
    const env = buildHermesSkillsListEnvironment({ FORCE_COLOR: "3", TERM: "xterm-256color" });
    assert.equal(env.FORCE_COLOR, "0");
    assert.equal(env.NO_COLOR, "1");
    assert.equal(env.TERM, "dumb");
  });
});

describe("annotateHermesSkillsWithEnableState", () => {
  it("disables a scanned skill the listing omits", () => {
    const annotated = annotateHermesSkillsWithEnableState(
      [skill("pdf"), skill("noisy-skill")],
      [{ name: "pdf", category: "productivity", source: "builtin", trust: "builtin" }],
    );
    assert.deepStrictEqual(
      annotated.map((entry) => ({ name: entry.name, enabled: entry.enabled })),
      [
        { name: "pdf", enabled: true },
        { name: "noisy-skill", enabled: false },
      ],
    );
  });

  it("fills a missing scope from the listing's category", () => {
    const [withScope, withoutCategory] = annotateHermesSkillsWithEnableState(
      [skill("pdf"), skill("loose")],
      [
        { name: "pdf", category: "productivity", source: "builtin", trust: "builtin" },
        { name: "loose", category: undefined, source: "local", trust: "local" },
      ],
    );
    assert.equal(withScope?.scope, "productivity");
    assert.isUndefined(withoutCategory?.scope);
  });

  it("never overwrites a scope the scan already established", () => {
    // Project vs user is a trust distinction the picker's source badge reads;
    // a category is only a grouping hint and must not clobber it.
    const [annotated] = annotateHermesSkillsWithEnableState(
      [skill("deploy", { scope: "project" })],
      [{ name: "deploy", category: "devops", source: "local", trust: "local" }],
    );
    assert.equal(annotated?.scope, "project");
  });

  it("leaves every skill enabled when the listing could not be read", () => {
    const skills = [skill("pdf"), skill("arxiv")];
    assert.deepStrictEqual(
      [...annotateHermesSkillsWithEnableState(skills, undefined)],
      [...skills],
    );
  });

  it("leaves every skill enabled when the listing is empty but the scan found some", () => {
    // Everything-disabled and parser-broke are indistinguishable here, and
    // they differ enormously in cost: a cosmetic over-report versus an empty
    // picker. Fail open.
    const skills = [skill("pdf")];
    assert.deepStrictEqual([...annotateHermesSkillsWithEnableState(skills, [])], [...skills]);
  });

  it("returns nothing when the scan found nothing", () => {
    assert.deepStrictEqual([...annotateHermesSkillsWithEnableState([], [])], []);
  });
});
