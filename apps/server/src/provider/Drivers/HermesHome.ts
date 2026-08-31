/**
 * HermesHome — resolve the Hermes home directory an instance runs against.
 *
 * Hermes keeps everything under one root (`hermes_constants.get_hermes_home`):
 * `config.yaml`, `.env`, `auth.json`, `state.db`, and `skills/`. The root is
 * `HERMES_HOME` when set, `%LOCALAPPDATA%\hermes` on native Windows, and
 * `~/.hermes` everywhere else — including WSL2, which the CLI treats as Linux.
 *
 * Two callers need the same answer: the spawn environment (so the child CLI
 * reads the instance's own config) and skill discovery (so the `$` picker
 * scans the directory that child will actually load from). Keeping the
 * resolution here means those two can never drift.
 *
 * @module provider/Drivers/HermesHome
 */
import * as NodeOS from "node:os";

import type { HermesSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/** Environment variable Hermes reads to relocate its home directory. */
export const HERMES_HOME_ENV = "HERMES_HOME";

/**
 * Environment variable that tells the ACP adapter to skip starting the MCP
 * servers listed in `config.yaml`. Hermes checks for the exact string `"1"`
 * (`acp_adapter/entry.py`), so anything else is treated as unset.
 */
export const HERMES_ACP_SKIP_CONFIGURED_MCP_ENV = "HERMES_ACP_SKIP_CONFIGURED_MCP";

/**
 * Resolve the Hermes home directory, matching the precedence the spawned CLI
 * sees: the instance's configured `homePath` (exported as `HERMES_HOME` by
 * {@link buildHermesEnvironment}), then a `HERMES_HOME` already present in the
 * process environment, then the platform default.
 *
 * A configured `homePath` is tilde-expanded because it comes from the settings
 * form, where `~/.hermes` is what a user types. An inherited `HERMES_HOME` is
 * not: env vars reach a child process verbatim and are never shell-expanded,
 * so a literal `~` must stay literal for discovery to scan the same directory
 * the runtime would. A relative value is resolved against the workspace cwd —
 * the subprocess's own cwd — for the same reason.
 */
export const resolveHermesHomePath = Effect.fn("resolveHermesHomePath")(function* (
  config: Pick<HermesSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const configuredHome = config.homePath.trim();
  if (configuredHome.length > 0) {
    return path.resolve(expandHomePath(configuredHome));
  }

  const environmentHome = environment[HERMES_HOME_ENV]?.trim() ?? "";
  if (environmentHome.length > 0) {
    return cwd ? path.resolve(cwd, environmentHome) : path.resolve(environmentHome);
  }

  // `%LOCALAPPDATA%\hermes` is the native-Windows install root. WSL2 installs
  // under `~/.hermes` like Linux and reports itself as linux, so the platform
  // check is the correct discriminator here.
  const localAppData = environment.LOCALAPPDATA?.trim() ?? "";
  if (platform === "win32" && localAppData.length > 0) {
    return path.join(localAppData, "hermes");
  }
  return path.join(NodeOS.homedir(), ".hermes");
});

/**
 * Build the environment for a spawned `hermes acp` process.
 *
 * Only the variables the instance actually configures are written; everything
 * else is inherited so Hermes' own credential resolution
 * (`hermes_cli/auth.py resolve_provider`) keeps working from the user's shell
 * environment and `<home>/.env`.
 */
export function buildHermesEnvironment(input: {
  readonly config: Pick<HermesSettings, "homePath" | "skipConfiguredMcpServers">;
  readonly environment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const homePath = input.config.homePath.trim();
  return {
    ...input.environment,
    ...(homePath.length > 0 ? { [HERMES_HOME_ENV]: expandHomePath(homePath) } : {}),
    ...(input.config.skipConfiguredMcpServers ? { [HERMES_ACP_SKIP_CONFIGURED_MCP_ENV]: "1" } : {}),
  };
}
