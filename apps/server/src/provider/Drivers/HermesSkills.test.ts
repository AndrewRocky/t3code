import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverHermesSkills,
  parseHermesSkillConfigRoots,
  parseHermesSkillFrontmatter,
} from "./HermesSkills.ts";

/**
 * `relativeDirectory` is a path, not a name: a real Hermes install nests
 * every skill under a category (`skills/productivity/pdf/SKILL.md`), and
 * fixtures that wrote a flat `skills/pdf/SKILL.md` are what let a
 * single-level scan look correct while finding nothing on a real machine.
 */
const writeSkill = Effect.fn(function* (
  skillsDir: string,
  relativeDirectory: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, ...relativeDirectory.split("/"));
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

const frontmatter = (name: string, description: string) =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", "# Body"].join("\n");

describe("parseHermesSkillFrontmatter", () => {
  it("reads name and description", () => {
    assert.deepStrictEqual(
      parseHermesSkillFrontmatter(
        ["---", "name: deploy", "description: Ship the app.", "---", "", "# Body"].join("\n"),
      ),
      { kind: "parsed", name: "deploy", description: "Ship the app." },
    );
  });

  it("reports a missing block separately from a malformed one", () => {
    assert.deepStrictEqual(parseHermesSkillFrontmatter("# Just a heading"), { kind: "missing" });
    assert.deepStrictEqual(parseHermesSkillFrontmatter(["---", "name: [", "---"].join("\n")), {
      kind: "malformed",
    });
  });

  it("treats a scalar frontmatter document as malformed", () => {
    assert.deepStrictEqual(
      parseHermesSkillFrontmatter(["---", "just-a-string", "---"].join("\n")),
      {
        kind: "malformed",
      },
    );
  });
});

it.layer(NodeServices.layer)("discoverHermesSkills", (it) => {
  it.effect("discovers user and project skills, with project winning collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      const workspace = path.join(tempDir, "workspace");

      // Category-nested, the way `tools/skills_sync.py` installs them.
      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "autonomous-ai-agents/memory-curator",
        frontmatter("memory-curator", "Curate memory."),
      );
      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "devops/deploy",
        frontmatter("deploy", "User-scope deploy."),
      );
      yield* writeSkill(
        path.join(workspace, ".hermes", "skills"),
        "deploy",
        frontmatter("deploy", "Project-scope deploy."),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "quality/review",
        frontmatter("review", "Review the diff."),
      );

      const skills = yield* discoverHermesSkills(
        { homePath: hermesHome },
        { HERMES_HOME: "/ignored-because-homePath-wins" },
        workspace,
      );

      assert.deepStrictEqual(
        skills.map((skill) => ({
          name: skill.name,
          scope: skill.scope,
          description: skill.description,
        })),
        [
          { name: "deploy", scope: "project", description: "Project-scope deploy." },
          { name: "memory-curator", scope: "user", description: "Curate memory." },
          { name: "review", scope: "project", description: "Review the diff." },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to HERMES_HOME when no homePath is configured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-env-" });
      const hermesHome = path.join(tempDir, "env-home");

      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "session-search",
        ["---", "name: session-search", "description: Search past sessions.", "---"].join("\n"),
      );

      const skills = yield* discoverHermesSkills({ homePath: "" }, { HERMES_HOME: hermesHome });
      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["session-search"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("skips bookkeeping dotfiles and malformed skills without failing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-junk-" });
      const hermesHome = path.join(tempDir, "home");
      const skillsDir = path.join(hermesHome, "skills");

      // Hermes writes its sync manifest and opt-out marker beside the skills.
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, ".bundled_manifest"), "{}");
      yield* fs.writeFileString(path.join(skillsDir, ".no-bundled-skills"), "");

      yield* writeSkill(skillsDir, "broken", ["---", "name: [", "---"].join("\n"));
      yield* writeSkill(skillsDir, "healthy", ["---", "name: healthy", "---"].join("\n"));
      // A directory with no SKILL.md at all is not a skill.
      yield* fs.makeDirectory(path.join(skillsDir, "empty-dir"), { recursive: true });

      const skills = yield* discoverHermesSkills({ homePath: hermesHome }, {});
      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["healthy"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("names a skill after its directory when frontmatter omits a name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-unnamed-" });
      const hermesHome = path.join(tempDir, "home");

      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "unnamed-skill",
        ["---", "description: No name key.", "---"].join("\n"),
      );

      const skills = yield* discoverHermesSkills({ homePath: hermesHome }, {});
      assert.deepStrictEqual(
        skills.map((skill) => ({ name: skill.name, enabled: skill.enabled })),
        [{ name: "unnamed-skill", enabled: true }],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("finds category-nested and deeply nested skills alike", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-depth-" });
      const hermesHome = path.join(tempDir, "home");
      const skillsRoot = path.join(hermesHome, "skills");

      yield* writeSkill(skillsRoot, "flat", frontmatter("flat", "Directly under the root."));
      yield* writeSkill(
        skillsRoot,
        "productivity/pdf",
        frontmatter("pdf", "Category-nested, the common case."),
      );
      yield* writeSkill(
        skillsRoot,
        "productivity/office/xlsx",
        frontmatter("xlsx", "Nested one level deeper."),
      );

      const skills = yield* discoverHermesSkills({ homePath: hermesHome }, {});
      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["flat", "pdf", "xlsx"],
      );
      // The path is what `skill_view` and the picker's source badge key off,
      // so it must be the real nested location.
      assert.equal(
        skills.find((skill) => skill.name === "xlsx")?.path,
        path.join(skillsRoot, "productivity", "office", "xlsx", "SKILL.md"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not mistake a skill's payload directories for skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-support-" });
      const hermesHome = path.join(tempDir, "home");
      const skillsRoot = path.join(hermesHome, "skills");

      yield* writeSkill(skillsRoot, "research/arxiv", frontmatter("arxiv", "Fetch papers."));
      // Progressive-disclosure payloads; Hermes prunes these under a skill
      // root and serves them only through `skill_view(file_path=...)`.
      for (const support of ["references", "templates", "assets", "scripts"]) {
        yield* writeSkill(
          skillsRoot,
          `research/arxiv/${support}`,
          frontmatter(`${support}-decoy`, "Must not be discovered."),
        );
      }
      // A dependency tree that happens to sit inside a skills root.
      yield* writeSkill(
        skillsRoot,
        "research/node_modules/some-package",
        frontmatter("vendored-decoy", "Must not be discovered."),
      );

      const skills = yield* discoverHermesSkills({ homePath: hermesHome }, {});
      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["arxiv"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("resolves the org mirror only for the active org", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-org-" });
      const hermesHome = path.join(tempDir, "home");
      const skillsRoot = path.join(hermesHome, "skills");

      yield* writeSkill(skillsRoot, "core/local", frontmatter("local", "Always present."));
      yield* writeSkill(skillsRoot, "_org/acme/shared", frontmatter("acme-shared", "Org skill."));
      yield* writeSkill(skillsRoot, "_org/other/shared", frontmatter("other-shared", "Org skill."));

      // No marker: the mirror is token-gated, so nothing under it resolves.
      const withoutMarker = yield* discoverHermesSkills({ homePath: hermesHome }, {});
      assert.deepStrictEqual(
        withoutMarker.map((skill) => skill.name),
        ["local"],
      );

      yield* fs.writeFileString(path.join(skillsRoot, "_org", ".active_org"), "acme\n");
      const withMarker = yield* discoverHermesSkills({ homePath: hermesHome }, {});
      assert.deepStrictEqual(
        withMarker.map((skill) => skill.name),
        ["acme-shared", "local"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("scans skills.create_dir and skills.external_dirs from config.yaml", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-roots-" });
      const hermesHome = path.join(tempDir, "home");
      const shared = path.join(tempDir, "team-skills");

      yield* fs.makeDirectory(hermesHome, { recursive: true });
      yield* fs.writeFileString(
        path.join(hermesHome, "config.yaml"),
        ["skills:", "  create_dir: authored", "  external_dirs:", `    - ${shared}`].join("\n"),
      );
      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "core/profile-local",
        frontmatter("profile-local", "From the profile root."),
      );
      // `create_dir` is relative, so it resolves against the Hermes home.
      yield* writeSkill(
        path.join(hermesHome, "authored"),
        "self-written",
        frontmatter("self-written", "Authored by the agent."),
      );
      yield* writeSkill(shared, "ops/team-runbook", frontmatter("team-runbook", "Shared root."));

      const skills = yield* discoverHermesSkills({ homePath: hermesHome }, {});
      assert.deepStrictEqual(
        skills.map((skill) => skill.name),
        ["profile-local", "self-written", "team-runbook"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("prefers the profile root over an external root on a name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-first-" });
      const hermesHome = path.join(tempDir, "home");
      const shared = path.join(tempDir, "shared");

      yield* fs.makeDirectory(hermesHome, { recursive: true });
      yield* fs.writeFileString(
        path.join(hermesHome, "config.yaml"),
        ["skills:", "  external_dirs:", `    - ${shared}`].join("\n"),
      );
      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "core/deploy",
        frontmatter("deploy", "Profile-local wins."),
      );
      yield* writeSkill(shared, "core/deploy", frontmatter("deploy", "External loses."));

      const skills = yield* discoverHermesSkills({ homePath: hermesHome }, {});
      assert.deepStrictEqual(
        skills.map((skill) => ({ name: skill.name, description: skill.description })),
        [{ name: "deploy", description: "Profile-local wins." }],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("returns an empty list when nothing is installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-skills-none-" });
      const skills = yield* discoverHermesSkills({ homePath: path.join(tempDir, "missing") }, {});
      assert.deepStrictEqual([...skills], []);
    }).pipe(Effect.scoped),
  );
});

describe("parseHermesSkillConfigRoots", () => {
  it("reads create_dir and external_dirs", () => {
    assert.deepStrictEqual(
      parseHermesSkillConfigRoots(
        [
          "skills:",
          "  create_dir: authored",
          "  external_dirs:",
          "    - ~/.agents/skills",
          "    - /shared/team-skills",
        ].join("\n"),
      ),
      { createDir: "authored", externalDirs: ["~/.agents/skills", "/shared/team-skills"] },
    );
  });

  it("yields no roots for a missing block, a blank value, or invalid YAML", () => {
    const empty = { createDir: undefined, externalDirs: [] };
    assert.deepStrictEqual(parseHermesSkillConfigRoots("model: openrouter:x"), empty);
    assert.deepStrictEqual(
      parseHermesSkillConfigRoots(["skills:", '  create_dir: "  "'].join("\n")),
      empty,
    );
    // A broken config.yaml must degrade to "no extra roots", never fail the
    // scan: Hermes itself refuses to write over one rather than repairing it.
    assert.deepStrictEqual(parseHermesSkillConfigRoots("skills: [unclosed"), empty);
  });

  it("ignores non-string entries in external_dirs", () => {
    assert.deepStrictEqual(
      parseHermesSkillConfigRoots(
        ["skills:", "  external_dirs:", "    - /ok", "    - 42", "    -", "    - '  '"].join("\n"),
      ),
      { createDir: undefined, externalDirs: ["/ok"] },
    );
  });
});
