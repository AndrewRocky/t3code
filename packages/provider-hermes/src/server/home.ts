import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { HermesSettings } from "../settings.ts";

const HERMES_HOME_ENV = "HERMES_HOME";

/**
 * The `HERMES_HOME` the spawned CLI will see. It also selects the gateway
 * daemon, so the spawn environment, skill discovery and the `state.db` reader
 * must all resolve it the same way: the configured `homePath` (tilde-expanded,
 * because it is typed into a form), then an inherited `HERMES_HOME` (taken
 * literally, as the child receives it), then the platform default.
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
  // WSL2 installs under `~/.hermes` and reports linux, so the platform is the right test.
  const localAppData = environment.LOCALAPPDATA?.trim() ?? "";
  if (platform === "win32" && localAppData.length > 0) {
    return path.join(localAppData, "hermes");
  }
  return path.join(homeDirectory, ".hermes");
});

/**
 * Only `HERMES_HOME` is written. The gateway daemon owns execution, so other
 * instance variables reach the viewer process but not tool runs; Hermes reads
 * credentials from `<home>/.env` itself.
 */
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
