import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { HermesSettings } from "../settings.ts";

const HERMES_HOME_ENV = "HERMES_HOME";

/**
 * The `HERMES_HOME` the CLI sees, which also selects the gateway daemon: the
 * configured `homePath` (tilde-expanded), then an inherited `HERMES_HOME`, then
 * the default. Spawn, skill discovery and the `state.db` readers must agree.
 */
export const resolveHermesHomePath = Effect.fn("resolveHermesHomePath")(function* (
  config: Pick<HermesSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const configuredHome = config.homePath.trim();
  if (configuredHome.length > 0) {
    return path.resolve(expandHomePath(configuredHome, homeDirectory));
  }
  const environmentHome = environment[HERMES_HOME_ENV]?.trim() ?? "";
  if (environmentHome.length > 0) {
    return cwd ? path.resolve(cwd, environmentHome) : path.resolve(environmentHome);
  }
  return defaultHermesHome(path, platform, homeDirectory, environment);
});

function defaultHermesHome(
  path: Path.Path,
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
): string {
  // WSL2 installs under `~/.hermes` and reports linux, so the platform is the right test.
  const localAppData = environment.LOCALAPPDATA?.trim() ?? "";
  if (platform === "win32" && localAppData.length > 0) {
    return path.join(localAppData, "hermes");
  }
  return path.join(homeDirectory, ".hermes");
}

/** A named profile's home, `<root>/profiles/<name>`, which Hermes takes as given. */
function isHermesProfileDirectory(home: string): boolean {
  return (
    home
      .split(/[\\/]+/u)
      .filter((part) => part.length > 0)
      .at(-2) === "profiles"
  );
}

/** Hermes' rule for profile names (`hermes_constants.PROFILE_ID_RE`). */
const HERMES_PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/**
 * The home Hermes itself runs in. Unless the home is a profile directory, Hermes
 * follows `hermes profile use <name>`, which `<root>/active_profile` records; a
 * missing profile stays the root, where Hermes reports it.
 */
export const resolveHermesActiveHome = Effect.fn("resolveHermesActiveHome")(function* (
  config: Pick<HermesSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* resolveHermesHomePath(config, environment);
  if (isHermesProfileDirectory(home)) return home;
  const nativeHome = defaultHermesHome(
    path,
    yield* HostProcess.Platform,
    yield* HostProcess.HomeDirectory,
    environment,
  );
  const fromNative = path.relative(nativeHome, home);
  const root = fromNative.startsWith("..") || path.isAbsolute(fromNative) ? home : nativeHome;
  const active = yield* fileSystem.readFileString(path.join(root, "active_profile")).pipe(
    Effect.map((text) =>
      text
        .replace(/^\uFEFF/u, "")
        .trim()
        .toLowerCase(),
    ),
    Effect.orElseSucceed(() => ""),
  );
  if (active === "" || active === "default" || !HERMES_PROFILE_ID.test(active)) return home;
  const profileHome = path.join(root, "profiles", active);
  const exists = yield* fileSystem.exists(profileHome).pipe(Effect.orElseSucceed(() => false));
  return exists ? profileHome : home;
});

/**
 * The settings and environment every Hermes command of one instance runs with:
 * T3's own environment and one home, resolved once. Instance variables only
 * select the home: a gateway T3 starts keeps the environment it was started
 * with and runs every Hermes client of that home.
 */
export const pinHermesHome = Effect.fn("pinHermesHome")(function* <
  Settings extends Pick<HermesSettings, "homePath">,
>(
  settings: Settings,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const selection = yield* mergeProviderInstanceEnvironment(instanceEnvironment, hostEnvironment);
  const home = yield* resolveHermesActiveHome(settings, selection);
  const windows = (yield* HostProcess.Platform) === "win32";
  const environment: NodeJS.ProcessEnv = { ...hostEnvironment };
  if (windows) {
    for (const name of Object.keys(environment)) {
      if (name.toUpperCase() === HERMES_HOME_ENV) delete environment[name];
    }
  }
  environment[HERMES_HOME_ENV] = home;
  return { settings: { ...settings, homePath: home }, environment };
});

/**
 * Keeps a root home from following a later `hermes profile use`, as Hermes does
 * when it starts its own gateway; a profile directory needs no selector.
 */
export function hermesProfileArgs(environment: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const home = environment[HERMES_HOME_ENV]?.trim() ?? "";
  return home.length === 0 || isHermesProfileDirectory(home) ? [] : ["--profile", "default"];
}

/** Only `HERMES_HOME` is written; Hermes reads credentials from `<home>/.env` itself. */
export function buildHermesEnvironment(input: {
  readonly config: Pick<HermesSettings, "homePath">;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}): NodeJS.ProcessEnv {
  const homePath = input.config.homePath.trim();
  return {
    ...input.environment,
    ...(homePath.length > 0
      ? { [HERMES_HOME_ENV]: expandHomePath(homePath, input.homeDirectory) }
      : {}),
  };
}

/**
 * Expand a path entry from Hermes' `config.yaml` as Hermes does
 * (`os.path.expanduser(os.path.expandvars(entry))`): known variables are
 * substituted, unknown ones stay as written, then a leading `~`.
 */
export function expandHermesConfigPath(
  entry: string,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const withVariables = entry.replace(/\$(\w+|\{[^}]*\})/g, (match, name: string) => {
    const key = name.startsWith("{") ? name.slice(1, -1) : name;
    return environment[key] ?? match;
  });
  return expandHomePath(withVariables, homeDirectory);
}

const configLocks = new Map<string, Semaphore.Semaphore>();

/**
 * T3 rewrites `config.yaml` from the command-rule and worktree-trust syncs,
 * each a whole-file read-modify-write; without a lock two session starts drop
 * each other's change. Keyed by home, because instances can share one.
 */
export const withHermesConfigLock = <A, E, R>(
  home: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let lock = configLocks.get(home);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      configLocks.set(home, lock);
    }
    return lock.withPermit(effect);
  });
