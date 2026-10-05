// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { HermesDriver } from "./HermesDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-hermes-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("The Hermes driver test makes no HTTP request")),
    ),
  ),
);

/** A `hermes skills list --enabled-only` table naming `names`, as Rich renders it wide. */
const enabledSkillsTable = (names: ReadonlyArray<string>) =>
  [
    "                Installed Skills (enabled only)                ",
    "┏━━━━━━━━━━━━━━━━━┳━━━━━━━━━━┳━━━━━━━━┳━━━━━━━━┳━━━━━━━━━┓",
    "┃ Name            ┃ Category ┃ Source ┃ Trust  ┃ Status  ┃",
    "┡━━━━━━━━━━━━━━━━━╇━━━━━━━━━━╇━━━━━━━━╇━━━━━━━━╇━━━━━━━━━┩",
    ...names.map((name) => `│ ${name.padEnd(15)} │          │ local  │ local  │ enabled │`),
    "└─────────────────┴──────────┴────────┴────────┴─────────┘",
    "",
  ].join("\n");

const handle = (exitCode: number, stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

/**
 * A `hermes` that answers only the enable-state listing — reporting
 * `enabledNames` — and fails everything else, so the machine probe the
 * managed snapshot starts at creation settles as an error without ever
 * reaching a listing of its own.
 */
const fakeHermes = (
  enabledNames: ReadonlyArray<string> | ((cwd: string | undefined) => ReadonlyArray<string>),
  listingCwds: Array<string | undefined>,
) =>
  ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.succeed(handle(1, ""));
    }
    if (command.args.join(" ") === "skills list --enabled-only") {
      const cwd = command.options.cwd;
      listingCwds.push(cwd);
      return Effect.sync(() =>
        handle(
          0,
          enabledSkillsTable(typeof enabledNames === "function" ? enabledNames(cwd) : enabledNames),
        ),
      );
    }
    return Effect.succeed(handle(1, ""));
  });

const writeSkill = Effect.fn(function* (skillsRoot: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(skillsRoot, name);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(
    path.join(directory, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} skill.`, "---", ""].join("\n"),
  );
});

it.layer(testLayer)("HermesDriver.snapshotForCwd", (it) => {
  it.effect("lists the workspace's project skills, annotated by a listing run in it", () => {
    const listingCwds: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-driver-cwd-" }),
      );
      const hermesHome = path.join(tempDir, "hermes-home");
      const repo = path.join(tempDir, "repo");
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* writeSkill(path.join(hermesHome, "skills"), "unslop");
      yield* writeSkill(path.join(repo, ".agents", "skills"), "clickhouse-cli");
      // On disk but absent from Hermes' listing: disabled in config.yaml, say.
      yield* writeSkill(path.join(repo, ".agents", "skills"), "replay-modes");

      const instance = yield* HermesDriver.create({
        instanceId: ProviderInstanceId.make("hermes-workspace"),
        displayName: "Hermes test",
        enabled: true,
        environment: [],
        config: { ...HermesDriver.defaultConfig(), binaryPath: "hermes", homePath: hermesHome },
      });
      assert.isDefined(instance.snapshotForCwd);
      const scoped = yield* instance.snapshotForCwd!(repo);

      assert.deepStrictEqual(
        scoped.skills.map((skill) => ({
          name: skill.name,
          scope: skill.scope,
          enabled: skill.enabled,
        })),
        [
          { name: "clickhouse-cli", scope: "project", enabled: true },
          { name: "replay-modes", scope: "project", enabled: false },
          { name: "unslop", scope: "user", enabled: true },
        ],
      );
      // The listing derives its project root and trust decision from its own
      // cwd; run anywhere else it would omit the project skills and the
      // annotation would disable both.
      assert.deepStrictEqual(listingCwds, [repo]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        fakeHermes(["clickhouse-cli", "unslop"], listingCwds),
      ),
      Effect.scoped,
    );
  });

  it.effect("trusts a new worktree before Hermes lists its skills", () => {
    const listingCwds: Array<string | undefined> = [];
    const fixture: { configPath?: string } = {};
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-driver-trust-" }),
      );
      const hermesHome = path.join(tempDir, "hermes-home");
      const main = path.join(tempDir, "repo");
      const worktree = path.join(tempDir, "worktrees", "fan-3470");
      const gitDir = path.join(main, ".git", "worktrees", "fan-3470");
      yield* fs.makeDirectory(gitDir, { recursive: true });
      yield* fs.writeFileString(path.join(gitDir, "commondir"), "../..\n");
      yield* fs.makeDirectory(worktree, { recursive: true });
      yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      yield* writeSkill(path.join(worktree, ".agents", "skills"), "clickhouse-cli");
      // Always listed, so an untrusted listing is a real answer rather than
      // the empty table the annotation refuses to act on.
      yield* writeSkill(path.join(hermesHome, "skills"), "unslop");
      fixture.configPath = path.join(hermesHome, "config.yaml");
      yield* fs.makeDirectory(hermesHome, { recursive: true });
      yield* fs.writeFileString(
        fixture.configPath,
        `skills:\n  trusted_project_dirs:\n    - ${main}\n`,
      );

      const instance = yield* HermesDriver.create({
        instanceId: ProviderInstanceId.make("hermes-worktree"),
        displayName: "Hermes test",
        enabled: true,
        environment: [],
        config: {
          ...HermesDriver.defaultConfig(),
          binaryPath: "hermes",
          homePath: hermesHome,
          trustWorktreesOfTrustedProjects: true,
        },
      });
      const scoped = yield* instance.snapshotForCwd!(worktree);

      assert.deepStrictEqual(
        scoped.skills.map((skill) => ({ name: skill.name, enabled: skill.enabled })),
        [
          { name: "clickhouse-cli", enabled: true },
          { name: "unslop", enabled: true },
        ],
      );
      assert.deepStrictEqual(listingCwds, [worktree]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        // Like Hermes: a project's skills load only once its root is trusted
        // in config.yaml, read when the listing runs.
        fakeHermes((cwd) => {
          const config = NodeFS.readFileSync(fixture.configPath ?? "", "utf8");
          const trusted = cwd !== undefined && config.includes(cwd);
          return trusted ? ["clickhouse-cli", "unslop"] : ["unslop"];
        }, listingCwds),
      ),
      Effect.scoped,
    );
  });

  it.effect("returns the machine snapshot untouched for a disabled instance", () =>
    Effect.gen(function* () {
      const instance = yield* HermesDriver.create({
        instanceId: ProviderInstanceId.make("hermes-disabled"),
        displayName: "Hermes test",
        enabled: false,
        environment: [],
        config: HermesDriver.defaultConfig(),
      });
      const machine = yield* instance.snapshot.getSnapshot;
      const scoped = yield* instance.snapshotForCwd!(process.cwd());
      assert.deepStrictEqual(scoped, machine);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("A disabled Hermes must not spawn a process")),
      ),
      Effect.scoped,
    ),
  );
});
