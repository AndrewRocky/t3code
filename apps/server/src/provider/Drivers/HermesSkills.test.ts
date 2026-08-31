import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverHermesSkills, parseHermesSkillFrontmatter } from "./HermesSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

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

      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "memory-curator",
        ["---", "name: memory-curator", "description: Curate memory.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User-scope deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".hermes", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project-scope deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "review",
        ["---", "name: review", "description: Review the diff.", "---"].join("\n"),
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
