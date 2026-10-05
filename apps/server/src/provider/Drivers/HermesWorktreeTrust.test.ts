import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

import {
  HERMES_WORKTREE_TRUST_PROVENANCE_FILE,
  mergeHermesWorktreeTrust,
  resolveLinkedWorktreeMainRoot,
  serializeHermesWorktreeTrustProvenance,
  syncHermesWorktreeTrust,
} from "./HermesWorktreeTrust.ts";

/**
 * A main checkout plus linked worktrees, laid out the way `git worktree add`
 * writes them (verified against git 2.43): the worktree's `.git` is a file
 * naming `<main>/.git/worktrees/<name>`, whose `commondir` is `../..`.
 */
const makeRepo = Effect.fn(function* (
  root: string,
  worktreeNames: ReadonlyArray<string>,
  options?: { readonly relativeGitDir?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const main = path.join(root, "main");
  yield* fs.makeDirectory(path.join(main, ".git"), { recursive: true });
  const worktrees: Record<string, string> = {};
  for (const name of worktreeNames) {
    const worktree = path.join(root, "worktrees", name);
    const gitDir = path.join(main, ".git", "worktrees", name);
    yield* fs.makeDirectory(gitDir, { recursive: true });
    yield* fs.makeDirectory(path.join(worktree, "src"), { recursive: true });
    yield* fs.writeFileString(path.join(gitDir, "commondir"), "../..\n");
    yield* fs.writeFileString(
      path.join(worktree, ".git"),
      `gitdir: ${options?.relativeGitDir ? path.relative(worktree, gitDir) : gitDir}\n`,
    );
    worktrees[name] = worktree;
  }
  return { main, worktrees };
});

const setup = Effect.fn(function* (prefix: string, worktreeNames: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }));
  const home = path.join(tempDir, "hermes-home");
  yield* fs.makeDirectory(home, { recursive: true });
  const repo = yield* makeRepo(tempDir, worktreeNames);
  return {
    tempDir,
    home,
    ...repo,
    configPath: path.join(home, "config.yaml"),
    provenancePath: path.join(home, HERMES_WORKTREE_TRUST_PROVENANCE_FILE),
  };
});

const readTrusted = Effect.fn(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const parsed = parseYamlDocument(yield* fs.readFileString(configPath)) as {
    skills?: { trusted_project_dirs?: ReadonlyArray<string> };
  } | null;
  return parsed?.skills?.trusted_project_dirs ?? [];
});

const decodeProvenance = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Number, trustedWorktrees: Schema.Array(Schema.String) }),
  ),
);

const readClaimed = Effect.fn(function* (provenancePath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(provenancePath))) return undefined;
  return decodeProvenance(yield* fs.readFileString(provenancePath)).trustedWorktrees;
});

const on = (home: string) => ({ homePath: home, trustWorktreesOfTrustedProjects: true });
const off = (home: string) => ({ homePath: home, trustWorktreesOfTrustedProjects: false });

it.layer(NodeServices.layer)("resolveLinkedWorktreeMainRoot", (it) => {
  it.effect("finds the main checkout from an absolute or a relative gitdir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-wt-root-" }),
      );
      const absolute = yield* makeRepo(path.join(tempDir, "a"), ["feature"]);
      const relative = yield* makeRepo(path.join(tempDir, "r"), ["feature"], {
        relativeGitDir: true,
      });

      assert.equal(
        yield* resolveLinkedWorktreeMainRoot(absolute.worktrees.feature!),
        absolute.main,
      );
      assert.equal(
        yield* resolveLinkedWorktreeMainRoot(relative.worktrees.feature!),
        relative.main,
      );
      // A main checkout is not a linked worktree of anything.
      assert.isUndefined(yield* resolveLinkedWorktreeMainRoot(absolute.main));
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a submodule and a worktree of a bare repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-wt-reject-" }),
      );

      // Submodule: a `.git` file too, but its gitdir has no `commondir`.
      const superproject = path.join(tempDir, "super");
      const submodule = path.join(superproject, "vendor", "lib");
      yield* fs.makeDirectory(path.join(superproject, ".git", "modules", "lib"), {
        recursive: true,
      });
      yield* fs.makeDirectory(submodule, { recursive: true });
      yield* fs.writeFileString(path.join(submodule, ".git"), "gitdir: ../../.git/modules/lib\n");
      assert.isUndefined(yield* resolveLinkedWorktreeMainRoot(submodule));

      // Bare: the common dir is `repo.git`, not a checkout's `.git`.
      const bareGitDir = path.join(tempDir, "repo.git", "worktrees", "wt");
      const bareWorktree = path.join(tempDir, "wt");
      yield* fs.makeDirectory(bareGitDir, { recursive: true });
      yield* fs.makeDirectory(bareWorktree, { recursive: true });
      yield* fs.writeFileString(path.join(bareGitDir, "commondir"), "../..\n");
      yield* fs.writeFileString(path.join(bareWorktree, ".git"), `gitdir: ${bareGitDir}\n`);
      assert.isUndefined(yield* resolveLinkedWorktreeMainRoot(bareWorktree));
    }).pipe(Effect.scoped),
  );
});

describe("mergeHermesWorktreeTrust", () => {
  it("appends a worktree and keeps everything else in the document", () => {
    const merged = mergeHermesWorktreeTrust(
      { model: "glm", skills: { disabled: ["x"], trusted_project_dirs: ["/repo"] } },
      { add: "/wt", remove: new Set() },
    );
    assert.deepStrictEqual(merged?.next, {
      model: "glm",
      skills: { disabled: ["x"], trusted_project_dirs: ["/repo", "/wt"] },
    });
    assert.equal(merged?.added, "/wt");
  });

  it("reads a scalar entry the way Hermes does, and writes back a list", () => {
    const merged = mergeHermesWorktreeTrust(
      { skills: { trusted_project_dirs: "/repo" } },
      { add: "/wt", remove: new Set() },
    );
    assert.deepStrictEqual(merged?.next, { skills: { trusted_project_dirs: ["/repo", "/wt"] } });
  });

  it("removes only the named entries, and drops keys it empties", () => {
    const kept = mergeHermesWorktreeTrust(
      { skills: { trusted_project_dirs: ["/repo", "/gone", 7] } },
      { add: undefined, remove: new Set(["/gone"]) },
    );
    assert.deepStrictEqual(kept?.next, { skills: { trusted_project_dirs: ["/repo", 7] } });
    assert.deepStrictEqual(kept?.removed, ["/gone"]);

    const emptied = mergeHermesWorktreeTrust(
      { model: "glm", skills: { trusted_project_dirs: ["/gone"] } },
      { add: undefined, remove: new Set(["/gone"]) },
    );
    assert.deepStrictEqual(emptied?.next, { model: "glm" });
  });

  it("reports no change for an entry that is already present", () => {
    const merged = mergeHermesWorktreeTrust(
      { skills: { trusted_project_dirs: ["/wt"] } },
      { add: "/wt", remove: new Set() },
    );
    assert.equal(merged?.changed, false);
  });

  it("refuses shapes T3 did not write", () => {
    const change = { add: "/wt", remove: new Set<string>() };
    assert.isUndefined(mergeHermesWorktreeTrust(["a"], change));
    assert.isUndefined(mergeHermesWorktreeTrust({ skills: "on" }, change));
    assert.isUndefined(
      mergeHermesWorktreeTrust({ skills: { trusted_project_dirs: { a: 1 } } }, change),
    );
  });
});

it.layer(NodeServices.layer)("syncHermesWorktreeTrust", (it) => {
  it.effect("trusts a worktree of a trusted project, once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* setup("t3-hermes-wt-trust-", ["feature"]);
      const worktree = repo.worktrees.feature!;
      yield* fs.writeFileString(
        repo.configPath,
        `model: glm\nskills:\n  trusted_project_dirs:\n    - ${repo.main}\n`,
      );

      yield* syncHermesWorktreeTrust(on(repo.home), {}, path.join(worktree, "src"));
      assert.deepStrictEqual(yield* readTrusted(repo.configPath), [repo.main, worktree]);
      assert.deepStrictEqual(yield* readClaimed(repo.provenancePath), [worktree]);

      const afterFirst = yield* fs.readFileString(repo.configPath);
      yield* syncHermesWorktreeTrust(on(repo.home), {}, worktree);
      assert.equal(yield* fs.readFileString(repo.configPath), afterFirst);
      assert.deepStrictEqual(yield* readClaimed(repo.provenancePath), [worktree]);
    }).pipe(Effect.scoped),
  );

  it.effect("recognises the main checkout through ~, $VAR, or a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* setup("t3-hermes-wt-expand-", ["feature"]);
      const link = path.join(repo.tempDir, "projects-link");
      yield* fs.symlink(repo.tempDir, link);
      yield* fs.writeFileString(
        repo.configPath,
        "skills:\n  trusted_project_dirs:\n    - ${PROJECTS}/main\n",
      );

      yield* syncHermesWorktreeTrust(on(repo.home), { PROJECTS: link }, repo.worktrees.feature!);
      assert.deepStrictEqual(yield* readTrusted(repo.configPath), [
        "${PROJECTS}/main",
        repo.worktrees.feature!,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing for an untrusted project or outside a worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* setup("t3-hermes-wt-untrusted-", ["feature"]);
      const original = "model: glm\nskills:\n  trusted_project_dirs:\n    - /somewhere/else\n";
      yield* fs.writeFileString(repo.configPath, original);

      yield* syncHermesWorktreeTrust(on(repo.home), {}, repo.worktrees.feature!);
      yield* syncHermesWorktreeTrust(on(repo.home), {}, repo.main);
      assert.equal(yield* fs.readFileString(repo.configPath), original);
      assert.isUndefined(yield* readClaimed(repo.provenancePath));
    }).pipe(Effect.scoped),
  );

  it.effect("never writes anything while the setting is off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* setup("t3-hermes-wt-default-", ["feature"]);
      const original = `skills:\n  trusted_project_dirs:\n    - ${repo.main}\n`;
      yield* fs.writeFileString(repo.configPath, original);

      yield* syncHermesWorktreeTrust(off(repo.home), {}, repo.worktrees.feature!);
      assert.equal(yield* fs.readFileString(repo.configPath), original);
      assert.isUndefined(yield* readClaimed(repo.provenancePath));
    }).pipe(Effect.scoped),
  );

  it.effect("revokes its own entries when turned off, leaving the user's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* setup("t3-hermes-wt-off-", ["feature", "mine"]);
      const feature = repo.worktrees.feature!;
      const mine = repo.worktrees.mine!;
      // `mine` was trusted by hand with `hermes skills trust`.
      yield* fs.writeFileString(
        repo.configPath,
        `skills:\n  trusted_project_dirs:\n    - ${repo.main}\n    - ${mine}\n`,
      );
      yield* syncHermesWorktreeTrust(on(repo.home), {}, feature);
      assert.deepStrictEqual(yield* readClaimed(repo.provenancePath), [feature]);

      yield* syncHermesWorktreeTrust(off(repo.home), {}, repo.main);
      assert.deepStrictEqual(yield* readTrusted(repo.configPath), [repo.main, mine]);
      assert.isUndefined(yield* readClaimed(repo.provenancePath));
    }).pipe(Effect.scoped),
  );

  it.effect("revokes trust for a worktree that no longer exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* setup("t3-hermes-wt-gone-", ["feature", "next"]);
      const feature = repo.worktrees.feature!;
      const next = repo.worktrees.next!;
      yield* fs.writeFileString(
        repo.configPath,
        `skills:\n  trusted_project_dirs:\n    - ${repo.main}\n`,
      );
      yield* syncHermesWorktreeTrust(on(repo.home), {}, feature);
      yield* fs.remove(feature, { recursive: true });

      // Any later sync prunes it, wherever it runs.
      yield* syncHermesWorktreeTrust(on(repo.home), {}, next);
      assert.deepStrictEqual(yield* readTrusted(repo.configPath), [repo.main, next]);
      assert.deepStrictEqual(yield* readClaimed(repo.provenancePath), [next]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps every entry when several worktree sessions start together", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = ["a", "b", "c", "d", "e", "f"];
      const repo = yield* setup("t3-hermes-wt-race-", names);
      yield* fs.writeFileString(
        repo.configPath,
        `skills:\n  trusted_project_dirs:\n    - ${repo.main}\n`,
      );

      yield* Effect.forEach(
        names,
        (name) => syncHermesWorktreeTrust(on(repo.home), {}, repo.worktrees[name]!),
        { concurrency: "unbounded", discard: true },
      );
      const trusted = yield* readTrusted(repo.configPath);
      assert.deepStrictEqual(
        [...trusted].sort(),
        [repo.main, ...names.map((name) => repo.worktrees[name]!)].sort(),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("leaves an unparseable config.yaml byte-identical", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* setup("t3-hermes-wt-bad-", ["feature"]);
      const broken = "skills: [unclosed\n";
      yield* fs.writeFileString(repo.configPath, broken);

      yield* syncHermesWorktreeTrust(on(repo.home), {}, repo.worktrees.feature!);
      assert.equal(yield* fs.readFileString(repo.configPath), broken);
    }).pipe(Effect.scoped),
  );
});

describe("serializeHermesWorktreeTrustProvenance", () => {
  it("writes a versioned record", () => {
    assert.deepStrictEqual(decodeProvenance(serializeHermesWorktreeTrustProvenance(["/wt"])), {
      version: 1,
      trustedWorktrees: ["/wt"],
    });
  });
});
