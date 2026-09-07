import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument, stringify as stringifyYamlDocument } from "yaml";

import {
  HERMES_COMMAND_RULES_PROVENANCE_FILE,
  mergeHermesCommandRules,
  serializeHermesCommandRulesProvenance,
  syncHermesCommandRules,
} from "./HermesCommandRules.ts";

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

  it("reports the patterns it now claims authorship of", () => {
    const result = mergeHermesCommandRules(
      { command_allowlist: ["git status*"] },
      { allowlist: ["git status*", "cargo test*"], denylist: ["sudo *"] },
    );
    assert.deepStrictEqual(result?.added, { allowlist: ["cargo test*"], denylist: ["sudo *"] });
    assert.deepStrictEqual(result?.removed, { allowlist: [], denylist: [] });
    assert.deepStrictEqual(result?.synced, {
      allowlist: ["git status*", "cargo test*"],
      denylist: ["sudo *"],
    });
  });
});

describe("mergeHermesCommandRules provenance-scoped removal", () => {
  it("removes a pattern T3 previously wrote once it leaves settings", () => {
    const existing = { command_allowlist: ["git status*", "rm -rf *"] };
    const result = mergeHermesCommandRules(
      existing,
      { allowlist: ["git status*"], denylist: [] },
      { allowlist: ["git status*", "rm -rf *"], denylist: [] },
    );
    assert.equal(result?.changed, true);
    assert.deepStrictEqual(result?.next.command_allowlist, ["git status*"]);
    assert.deepStrictEqual(result?.removed.allowlist, ["rm -rf *"]);
  });

  it("removes a revoked denylist pattern while preserving unrelated approvals keys", () => {
    const existing = { approvals: { mode: "manual", deny: ["sudo *", "shutdown *"] } };
    const result = mergeHermesCommandRules(
      existing,
      { allowlist: [], denylist: ["sudo *"] },
      { allowlist: [], denylist: ["sudo *", "shutdown *"] },
    );
    assert.deepStrictEqual(result?.next.approvals, { mode: "manual", deny: ["sudo *"] });
    assert.deepStrictEqual(result?.removed.denylist, ["shutdown *"]);
  });

  // The guarantee that makes provenance-scoped removal safe: T3 revokes only
  // what T3 wrote. `recursive delete` here stands in for a pattern Hermes'
  // own `save_permanent_allowlist` appended from an "Allow always" answer.
  it("leaves a Hermes-added entry in place while revoking its own", () => {
    const existing = { command_allowlist: ["recursive delete", "git status*"] };
    const result = mergeHermesCommandRules(
      existing,
      { allowlist: [], denylist: [] },
      { allowlist: ["git status*"], denylist: [] },
    );
    assert.equal(result?.changed, true);
    assert.deepStrictEqual(result?.removed.allowlist, ["git status*"]);
    assert.deepStrictEqual(result?.next.command_allowlist, ["recursive delete"]);
  });

  it("never removes anything when no provenance record is available", () => {
    // A fresh T3 install pointed at an existing Hermes home: authorship is
    // unknown, so the merge stays purely additive.
    const existing = { command_allowlist: ["git status*"] };
    const result = mergeHermesCommandRules(existing, { allowlist: [], denylist: [] });
    assert.equal(result?.changed, false);
    assert.deepStrictEqual(result?.next.command_allowlist, ["git status*"]);
  });

  it("drops the allowlist key entirely once its last entry is revoked", () => {
    const result = mergeHermesCommandRules(
      { model: "openrouter:z-ai/glm-5.2", command_allowlist: ["git status*"] },
      { allowlist: [], denylist: [] },
      { allowlist: ["git status*"], denylist: [] },
    );
    assert.equal(result?.changed, true);
    assert.deepStrictEqual(result?.next, { model: "openrouter:z-ai/glm-5.2" });
  });

  it("drops an approvals mapping left with no keys of its own", () => {
    const result = mergeHermesCommandRules(
      { approvals: { deny: ["sudo *"] } },
      { allowlist: [], denylist: [] },
      { allowlist: [], denylist: ["sudo *"] },
    );
    assert.deepStrictEqual(result?.next, {});
  });

  it("keeps a revoked pattern's non-string neighbours untouched", () => {
    const result = mergeHermesCommandRules(
      { command_allowlist: [42, "git status*"] },
      { allowlist: [], denylist: [] },
      { allowlist: ["git status*"], denylist: [] },
    );
    assert.deepStrictEqual(result?.next.command_allowlist, [42]);
  });

  it("is a no-op when a revoked pattern is already absent from the file", () => {
    const result = mergeHermesCommandRules(
      { command_allowlist: ["recursive delete"] },
      { allowlist: [], denylist: [] },
      { allowlist: ["git status*"], denylist: [] },
    );
    assert.equal(result?.changed, false);
    assert.deepStrictEqual(result?.removed.allowlist, []);
    assert.deepStrictEqual(result?.next.command_allowlist, ["recursive delete"]);
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

  it.effect("records the patterns it wrote in a provenance sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");

      yield* syncHermesCommandRules(
        {
          homePath: hermesHome,
          commandAllowlist: ["git status*", ""],
          commandDenylist: ["sudo *"],
        },
        {},
      );

      const contents = yield* fs.readFileString(
        path.join(hermesHome, HERMES_COMMAND_RULES_PROVENANCE_FILE),
      );
      assert.equal(
        contents,
        serializeHermesCommandRulesProvenance({
          allowlist: ["git status*"],
          denylist: ["sudo *"],
        }),
      );
    }),
  );

  it.effect("revokes a pattern removed from settings on the next sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      const configPath = path.join(hermesHome, "config.yaml");

      yield* syncHermesCommandRules(
        {
          homePath: hermesHome,
          commandAllowlist: ["git status*", "rm -rf *"],
          commandDenylist: ["sudo *", "shutdown *"],
        },
        {},
      );
      // The user clicks the X on `rm -rf *` and on `shutdown *`.
      yield* syncHermesCommandRules(
        {
          homePath: hermesHome,
          commandAllowlist: ["git status*"],
          commandDenylist: ["sudo *"],
        },
        {},
      );

      const parsed = parseYamlDocument(yield* fs.readFileString(configPath)) as Record<
        string,
        unknown
      >;
      assert.deepStrictEqual(parsed.command_allowlist, ["git status*"]);
      assert.deepStrictEqual(parsed.approvals, { deny: ["sudo *"] });

      assert.equal(
        yield* fs.readFileString(path.join(hermesHome, HERMES_COMMAND_RULES_PROVENANCE_FILE)),
        serializeHermesCommandRulesProvenance({
          allowlist: ["git status*"],
          denylist: ["sudo *"],
        }),
      );
    }),
  );

  it.effect("leaves an entry T3 never wrote in place while revoking its own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      const configPath = path.join(hermesHome, "config.yaml");

      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: ["git status*"], commandDenylist: [] },
        {},
      );
      // Hermes' own `save_permanent_allowlist` appends a pattern the user
      // answered "Allow always" to, mid-session.
      const afterHermesWrite = parseYamlDocument(yield* fs.readFileString(configPath)) as Record<
        string,
        unknown
      >;
      yield* fs.writeFileString(
        configPath,
        stringifyYamlDocument({
          ...afterHermesWrite,
          command_allowlist: [...(afterHermesWrite.command_allowlist as Array<string>), "podman *"],
        }),
      );

      // The user then clears the T3-configured pattern.
      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: [], commandDenylist: [] },
        {},
      );

      const parsed = parseYamlDocument(yield* fs.readFileString(configPath)) as Record<
        string,
        unknown
      >;
      assert.deepStrictEqual(parsed.command_allowlist, ["podman *"]);
    }),
  );

  it.effect("removes the provenance sidecar once every T3 pattern is cleared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      const provenancePath = path.join(hermesHome, HERMES_COMMAND_RULES_PROVENANCE_FILE);

      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: ["git status*"], commandDenylist: [] },
        {},
      );
      assert.equal(yield* fs.exists(provenancePath), true);

      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: [], commandDenylist: [] },
        {},
      );

      assert.equal(yield* fs.exists(provenancePath), false);
      const parsed = parseYamlDocument(
        yield* fs.readFileString(path.join(hermesHome, "config.yaml")),
      ) as Record<string, unknown> | null;
      // The key is dropped rather than written back as an empty list.
      assert.isUndefined(parsed?.command_allowlist);
    }),
  );

  it.effect("leaves config.yaml untouched when no provenance record exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      yield* fs.makeDirectory(hermesHome, { recursive: true });
      const configPath = path.join(hermesHome, "config.yaml");
      const original = ["command_allowlist:", "  - git status*", ""].join("\n");
      yield* fs.writeFileString(configPath, original);

      // A fresh T3 install pointed at an existing Hermes home: nothing is
      // configured and nothing is claimed, so the file is not even opened.
      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: [], commandDenylist: [] },
        {},
      );

      assert.equal(yield* fs.readFileString(configPath), original);
    }),
  );

  it.effect("syncs additively when the provenance record is unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      yield* fs.makeDirectory(hermesHome, { recursive: true });
      const configPath = path.join(hermesHome, "config.yaml");
      yield* fs.writeFileString(
        configPath,
        ["command_allowlist:", "  - git status*", "  - podman *", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(hermesHome, HERMES_COMMAND_RULES_PROVENANCE_FILE),
        "{ not json",
      );

      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: ["cargo test*"], commandDenylist: [] },
        {},
      );

      const parsed = parseYamlDocument(yield* fs.readFileString(configPath)) as Record<
        string,
        unknown
      >;
      // Nothing removed on a record it could not read; the addition still lands.
      assert.deepStrictEqual(parsed.command_allowlist, ["git status*", "podman *", "cargo test*"]);
      // And the record is rewritten so the next sync can revoke properly.
      assert.equal(
        yield* fs.readFileString(path.join(hermesHome, HERMES_COMMAND_RULES_PROVENANCE_FILE)),
        serializeHermesCommandRulesProvenance({ allowlist: ["cargo test*"], denylist: [] }),
      );
    }),
  );

  it.effect("leaves the provenance record alone when config.yaml is unparseable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-command-rules-" });
      const hermesHome = path.join(tempDir, "hermes-home");
      const provenancePath = path.join(hermesHome, HERMES_COMMAND_RULES_PROVENANCE_FILE);

      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: ["git status*"], commandDenylist: [] },
        {},
      );
      const recorded = yield* fs.readFileString(provenancePath);
      yield* fs.writeFileString(
        path.join(hermesHome, "config.yaml"),
        "command_allowlist: [unterminated",
      );

      yield* syncHermesCommandRules(
        { homePath: hermesHome, commandAllowlist: [], commandDenylist: [] },
        {},
      );

      // T3 still owns what it owned: a broken config.yaml must not make the
      // next sync forget that `git status*` is its to revoke.
      assert.equal(yield* fs.readFileString(provenancePath), recorded);
    }),
  );
});
