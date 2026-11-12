import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { pinHermesHome, resolveHermesActiveHome } from "./home.ts";

/** A user home whose `~/.hermes` has the `work` profile, made the sticky one when `active` is set. */
const makeUserHome = Effect.fn(function* (active?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-home-" });
  const root = path.join(userHome, ".hermes");
  yield* fs.makeDirectory(path.join(root, "profiles", "work"), { recursive: true });
  if (active !== undefined) yield* fs.writeFileString(path.join(root, "active_profile"), active);
  return { userHome, root, work: path.join(root, "profiles", "work") };
});

it.layer(NodeServices.layer)("resolveHermesActiveHome", (it) => {
  it.effect("follows `hermes profile use` from the root, as Hermes does", () =>
    Effect.gen(function* () {
      const { userHome, root, work } = yield* makeUserHome("Work\n");
      const resolve = (homePath: string) =>
        resolveHermesActiveHome({ homePath }, {}).pipe(
          Effect.provideService(HostProcess.HomeDirectory, userHome),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
      expect(yield* resolve("")).toBe(work);
      expect(yield* resolve(root)).toBe(work);
      // A profile directory is taken as given.
      expect(yield* resolve(`${root}/profiles/other`)).toBe(`${root}/profiles/other`);
    }),
  );

  it.effect("stays at the root for `default` or a profile that is gone", () =>
    Effect.gen(function* () {
      for (const active of ["default", "gone"]) {
        const { userHome, root } = yield* makeUserHome(active);
        expect(
          yield* resolveHermesActiveHome({ homePath: "" }, {}).pipe(
            Effect.provideService(HostProcess.HomeDirectory, userHome),
            Effect.provideService(HostProcess.Platform, "linux"),
          ),
        ).toBe(root);
      }
    }),
  );
});

it.layer(NodeServices.layer)("pinHermesHome", (it) => {
  it.effect(
    "gives Hermes T3's own environment, and uses instance variables only for the home",
    () =>
      Effect.gen(function* () {
        const { userHome, work } = yield* makeUserHome();
        const pinned = yield* pinHermesHome(
          { homePath: "" },
          [
            { name: "HERMES_HOME", value: work, sensitive: false },
            { name: "OPENROUTER_API_KEY", value: "instance-key", sensitive: true },
          ],
          { PATH: "/usr/bin", HERMES_HOME: "/elsewhere" },
        ).pipe(
          Effect.provideService(HostProcess.HomeDirectory, userHome),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect(pinned.settings.homePath).toBe(work);
        expect(pinned.environment).toEqual({ PATH: "/usr/bin", HERMES_HOME: work });
      }),
  );
});
