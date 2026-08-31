import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { mergeHermesCommandRules, syncHermesCommandRules } from "./HermesCommandRules.ts";

describe("mergeHermesCommandRules", () => {
  it("adds allowlist/denylist patterns to an empty document", () => {
    const result = mergeHermesCommandRules(undefined, {
      allowlist: ["git status*", "cargo test*"],
      denylist: ["sudo *"],
    });
    assert.isDefined(result);
    assert.equal(result?.changed, true);
    assert.deepStrictEqual(result?.next.command_allowlist, ["git status*", "cargo test*"]);
    assert.deepStrictEqual(result?.next.approvals, { deny: ["sudo *"] });
  });

  it("is a no-op when every configured pattern is already present", () => {
    const existing = {
      command_allowlist: ["git status*"],
      approvals: { mode: "manual", deny: ["sudo *"] },
    };
    const result = mergeHermesCommandRules(existing, {
      allowlist: ["git status*"],
      denylist: ["sudo *"],
    });
    assert.isDefined(result);
    assert.equal(result?.changed, false);
    // Unrelated `approvals` keys survive untouched even on a no-op.
    assert.deepStrictEqual(result?.next, existing);
  });

  it("only appends the patterns missing from the file, preserving existing order", () => {
    const existing = { command_allowlist: ["git status*"] };
    const result = mergeHermesCommandRules(existing, {
      allowlist: ["git status*", "cargo test*", "npm run lint*"],
      denylist: [],
    });
    assert.equal(result?.changed, true);
    assert.deepStrictEqual(result?.next.command_allowlist, [
      "git status*",
      "cargo test*",
      "npm run lint*",
    ]);
  });

  it("preserves unrelated approvals keys when adding to the denylist", () => {
    const existing = { approvals: { mode: "manual", timeout: 120 } };
    const result = mergeHermesCommandRules(existing, {
      allowlist: [],
      denylist: ["sudo *"],
    });
    assert.equal(result?.changed, true);
    assert.deepStrictEqual(result?.next.approvals, {
      mode: "manual",
      timeout: 120,
      deny: ["sudo *"],
    });
  });

  it("never removes an entry not in T3 settings — Hermes or an admin may have added it", () => {
    // Simulates Hermes' own `save_permanent_allowlist` having appended a
    // pattern a user approved "always" mid-session, which T3 never configured.
    const existing = { command_allowlist: ["recursive delete"] };
    const result = mergeHermesCommandRules(existing, { allowlist: [], denylist: [] });
    assert.equal(result?.changed, false);
    assert.deepStrictEqual(result?.next.command_allowlist, ["recursive delete"]);
  });

  it("deduplicates configured patterns and ignores blank entries", () => {
    const result = mergeHermesCommandRules(undefined, {
      allowlist: ["git status*", "git status*", "", "cargo test*"],
      denylist: [],
    });
    assert.deepStrictEqual(result?.next.command_allowlist, ["git status*", "cargo test*"]);
  });

  it("refuses to touch a config.yaml whose root is not a mapping", () => {
    assert.isUndefined(
      mergeHermesCommandRules(["not", "a", "map"], { allowlist: ["git status*"], denylist: [] }),
    );
    assert.isUndefined(
      mergeHermesCommandRules("just-a-string", { allowlist: ["git status*"], denylist: [] }),
    );
  });

  it("leaves non-string entries in an existing list untouched while still appending", () => {
    const existing = { command_allowlist: [42, "git status*"] };
    const result = mergeHermesCommandRules(existing, {
      allowlist: ["cargo test*"],
      denylist: [],
    });
    assert.deepStrictEqual(result?.next.command_allowlist, [42, "git status*", "cargo test*"]);
  });
});

it.layer(NodeServices.layer)("syncHermesCommandRules", (it) => {
  it.effect("creates config.yaml with the configured lists when none exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");

      yield* syncHermesCommandRules(
        {
          homePath: hermesHome,
          commandAllowlist: ["git status*"],
          commandDenylist: ["sudo *"],
        },
        {},
      );

      const contents = yield* fs.readFileString(path.join(hermesHome, "config.yaml"));
      const parsed = parseYamlDocument(contents) as Record<string, unknown>;
      assert.deepStrictEqual(parsed.command_allowlist, ["git status*"]);
      assert.deepStrictEqual(parsed.approvals, { deny: ["sudo *"] });
    }),
  );

  it.effect("does not write when nothing is configured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");

      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: [], commandDenylist: [] },
        {},
      );

      const exists = yield* fs.exists(path.join(hermesHome, "config.yaml"));
      assert.equal(exists, false);
    }),
  );

  it.effect("preserves unrelated existing config.yaml content while appending", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      yield* fs.makeDirectory(hermesHome, { recursive: true });
      yield* fs.writeFileString(
        path.join(hermesHome, "config.yaml"),
        ["model: openrouter:z-ai/glm-5.2", "command_allowlist:", "  - recursive delete", ""].join(
          "\n",
        ),
      );

      yield* syncHermesCommandRules(
        {
          homePath: hermesHome,
          commandAllowlist: ["git status*"],
          commandDenylist: [],
        },
        {},
      );

      const contents = yield* fs.readFileString(path.join(hermesHome, "config.yaml"));
      const parsed = parseYamlDocument(contents) as Record<string, unknown>;
      assert.equal(parsed.model, "openrouter:z-ai/glm-5.2");
      assert.deepStrictEqual(parsed.command_allowlist, ["recursive delete", "git status*"]);
    }),
  );

  it.effect("leaves a config.yaml with invalid YAML untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      yield* fs.makeDirectory(hermesHome, { recursive: true });
      const brokenContents = "command_allowlist: [unterminated";
      yield* fs.writeFileString(path.join(hermesHome, "config.yaml"), brokenContents);

      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: ["git status*"], commandDenylist: [] },
        {},
      );

      const contents = yield* fs.readFileString(path.join(hermesHome, "config.yaml"));
      assert.equal(contents, brokenContents);
    }),
  );

  it.effect("re-syncing is idempotent — no rewrite once patterns are already present", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      const settings = {
        homePath: hermesHome,
        commandAllowlist: ["git status*"],
        commandDenylist: ["sudo *"],
      };

      yield* syncHermesCommandRules(settings, {});
      const configPath = path.join(hermesHome, "config.yaml");
      const firstWrite = yield* fs.stat(configPath);

      yield* syncHermesCommandRules(settings, {});
      const secondWrite = yield* fs.stat(configPath);

      // mtime is unchanged: the second sync read the same content it would
      // have written and skipped the atomic rename entirely.
      assert.deepStrictEqual(firstWrite.mtime, secondWrite.mtime);
    }),
  );
});
