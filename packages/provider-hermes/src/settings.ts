import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const HermesSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("hermes").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Hermes CLI binary.",
        providerSettingsForm: { placeholder: "hermes", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "HERMES_HOME path",
        description:
          "Hermes home directory holding config.yaml, .env, state.db and skills. It also selects which Hermes gateway daemon serves this instance.",
        providerSettingsForm: { placeholder: "~/.hermes", clearWhenEmpty: "omit" },
      }),
    ),
    // Hermes matches `skills.trusted_project_dirs` against the nearest `.git`,
    // so every linked worktree starts untrusted.
    trustWorktreesOfTrustedProjects: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Trust worktrees of trusted projects",
        description:
          "Load project skills in git worktrees of a project trusted with `hermes skills trust`. A worktree can check out another branch, so its skills may differ from the trusted checkout's.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Written into `command_allowlist` in Hermes' own config.yaml; see `server/commandRules.ts`.
    commandAllowlist: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Written into `approvals.deny`, which Hermes enforces even under YOLO.
    commandDenylist: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "trustWorktreesOfTrustedProjects"],
  },
);
export type HermesSettings = typeof HermesSettings.Type;
