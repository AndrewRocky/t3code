import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type ProviderApprovalOption,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import type { HermesSettings } from "../settings.ts";
import { buildHermesEnvironment } from "./home.ts";

export const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");

/** Not a Hermes model id: "use the model the Hermes session already runs on". */
export const HERMES_DEFAULT_MODEL_SLUG = "default";

/**
 * Read by the gateway only on `session.create`, as a launch flag; a load or
 * resume keeps the session's frozen value (`hermes_cli/gateway_chat.py`).
 */
const HERMES_YOLO_MODE_ENV = "HERMES_YOLO_MODE";

const HERMES_MODE_DEFAULT = "default";
const HERMES_MODE_ACCEPT_EDITS = "accept_edits";
const HERMES_MODE_DONT_ASK = "dont_ask";

/**
 * Hermes v0.23 publishes the edit modes as an `edit_approval_policy` config
 * option whose values are the policies, not the mode ids
 * (`acp_adapter/modes.py` `MODES`).
 */
export const HERMES_EDIT_APPROVAL_POLICY_CONFIG_ID = "edit_approval_policy";
const HERMES_EDIT_POLICY_BY_MODE: Readonly<Record<string, string>> = {
  [HERMES_MODE_DEFAULT]: "ask",
  [HERMES_MODE_ACCEPT_EDITS]: "workspace_session",
  [HERMES_MODE_DONT_ASK]: "session",
};

/** Hermes enforces these natively: edit modes plus YOLO for commands. It has no classifier mode. */
export const HERMES_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

function hermesAcpSpawnArgs(): ReadonlyArray<string> {
  return ["acp"];
}

/** Imports the ACP adapter and exits; it never contacts or starts the gateway daemon. */
export function hermesAcpCheckArgs(): ReadonlyArray<string> {
  return ["acp", "--check"];
}

/** Prints the derived version (`0.22.5`, or `0.22.5+N.g<sha>` on a source checkout). */
export function hermesAcpVersionArgs(): ReadonlyArray<string> {
  return ["acp", "--version"];
}

/**
 * An explicit approval or sandbox override asks for everything, as Grok does,
 * so the override is never bypassed by YOLO.
 */
export function hermesLaunchRuntimeMode(
  runtimePolicy: Pick<
    ProviderAdapter.ProviderAdapterV2RuntimePolicy,
    "runtimeMode" | "approvalPolicy" | "sandboxPolicy"
  >,
): RuntimeMode {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

/**
 * Hermes' modes gate edits only; commands go through its own approval checks,
 * which YOLO (Full access) skips while keeping the hard floors and
 * `approvals.deny`. Sensitive paths ask in every mode.
 */
export function hermesModeIdForRuntimeMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return HERMES_MODE_DONT_ASK;
    case "auto-accept-edits":
    case "auto":
      return HERMES_MODE_ACCEPT_EDITS;
    default:
      return HERMES_MODE_DEFAULT;
  }
}

export function hermesYoloForMode(modeId: string): boolean {
  return modeId === HERMES_MODE_DONT_ASK;
}

/** The v0.23 config-option value for a mode id; values already in policy form pass through. */
export function hermesEditPolicyForMode(modeId: string): string {
  return HERMES_EDIT_POLICY_BY_MODE[modeId] ?? modeId;
}

export function buildHermesAcpSpawnInput(input: {
  readonly settings: Pick<HermesSettings, "binaryPath" | "homePath">;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly yolo: boolean;
}): AcpSessionRuntime.AcpSpawnInput {
  const env = buildHermesEnvironment({
    config: input.settings,
    homeDirectory: input.homeDirectory,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
  // An inherited YOLO from the user's shell must not widen a Supervised session.
  delete env[HERMES_YOLO_MODE_ENV];
  if (input.yolo) env[HERMES_YOLO_MODE_ENV] = "1";
  return {
    command: input.settings.binaryPath || "hermes",
    args: [...hermesAcpSpawnArgs()],
    cwd: input.cwd,
    env,
  };
}

/**
 * Hermes ids are `<provider>:<model>`; Hermes lowercases the provider half, so
 * a stored selection keeps matching the live catalog. `undefined` means
 * "keep the session's model".
 */
export function resolveHermesAcpBaseModelId(model: string | null | undefined): string | undefined {
  const normalized = normalizeModelSlug(model, HERMES_DRIVER_KIND);
  if (!normalized || normalized === HERMES_DEFAULT_MODEL_SLUG) {
    return undefined;
  }
  const separator = normalized.indexOf(":");
  if (separator <= 0 || separator === normalized.length - 1) {
    // Hermes resolves a bare model name itself; guessing a provider could misroute it.
    return normalized;
  }
  return `${normalized.slice(0, separator).toLowerCase()}${normalized.slice(separator)}`;
}

export function formatHermesModelLabel(modelId: string): string {
  const separator = modelId.indexOf(":");
  if (separator <= 0 || separator === modelId.length - 1) {
    return modelId;
  }
  return `${modelId.slice(0, separator)} · ${modelId.slice(separator + 1)}`;
}

/**
 * Hermes lists `allow_session` as its first `allow_always`-kind option, and the
 * shared adapter answers `acceptForSession` with that one, so it stays session-scoped.
 */
export function hermesApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const firstAllowAlways = request.options.find((option) => option.kind === "allow_always");
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind);
  return [
    { decision: "cancel", label: "Cancel" },
    ...(has("reject_once") ? [{ decision: "decline", label: "Deny" } as const] : []),
    ...(firstAllowAlways?.optionId.trim() === "allow_session"
      ? [{ decision: "acceptForSession", label: "Allow for session" } as const]
      : []),
    ...(has("allow_once") ? [{ decision: "accept", label: "Allow once" } as const] : []),
  ];
}
