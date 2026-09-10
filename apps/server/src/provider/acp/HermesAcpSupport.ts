/**
 * HermesAcpSupport — per-provider ACP glue for Nous Research's Hermes Agent.
 *
 * Hermes exposes a standards-compliant ACP server over stdio (`hermes acp`,
 * `acp_adapter/entry.py` → `acp.run_agent(agent, use_unstable_protocol=True)`).
 * Four things differ enough from the other ACP providers to live here:
 *
 * 1. **Permission modes are session state, not CLI flags.** Grok maps T3's
 *    runtime mode onto `--permission-mode` at spawn time; Hermes has no such
 *    flag. It advertises three ACP session modes — `default`, `accept_edits`,
 *    `dont_ask` (`acp_adapter/server.py _MODE_TO_EDIT_APPROVAL_POLICY`) — and
 *    expects `session/set_mode` after the session exists. So the mapping runs
 *    post-start, through {@link applyHermesAcpSessionMode}.
 *
 *    Those modes gate *edits only*. Shell execution always round-trips through
 *    `session/request_permission`, which is why the adapter's own full-access
 *    auto-approval still matters even in `dont_ask`.
 *
 * 2. **Auth is advertised, never stored per-editor.** `acp_adapter/auth.py`
 *    always advertises the terminal method `hermes-setup` and, when
 *    credentials already resolve, a second method named for the active
 *    provider. `hermes-setup` is the only id guaranteed to be present, and
 *    Hermes accepts it unconditionally, so it is what we authenticate with.
 *
 * 3. **Model ids are `<provider>:<model>`** (`server.py _encode_model_choice`),
 *    so they carry both a colon and, usually, a slash. Selection goes through
 *    the unstable `session/set_model` capability, which Hermes implements.
 *
 * 4. **ACP is an optional extra.** `pip install -e '.[acp]'` provides
 *    `agent-client-protocol`; without it `hermes acp` exits non-zero with an
 *    install hint. {@link hermesAcpCheckArgs} is the cheap probe for that.
 *
 * @module provider/acp/HermesAcpSupport
 */
import { type HermesSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildHermesEnvironment } from "../Drivers/HermesHome.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { hermesToolCallAugment } from "./HermesToolCallAugment.ts";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");

/**
 * `acp_adapter/auth.py TERMINAL_SETUP_AUTH_METHOD_ID`. Always advertised, and
 * `server.py authenticate` accepts it case-insensitively whether or not
 * credentials resolve — it answers `null` rather than failing when they do
 * not, so startup never blocks on an unconfigured install.
 */
export const HERMES_AUTH_METHOD_SETUP = "hermes-setup";

/** Fallback model id when neither settings nor the live catalog offer one. */
export const HERMES_FALLBACK_MODEL_ID = "openrouter:z-ai/glm-5.2";

/** ACP session mode ids Hermes advertises (`acp_adapter/server.py:655`). */
export const HERMES_MODE_DEFAULT = "default";
export const HERMES_MODE_ACCEPT_EDITS = "accept_edits";
export const HERMES_MODE_DONT_ASK = "dont_ask";

export type HermesAcpRuntimeHermesSettings = Pick<
  HermesSettings,
  "binaryPath" | "homePath" | "skipConfiguredMcpServers"
>;

interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Arguments for the ACP server itself. */
export function hermesAcpSpawnArgs(): ReadonlyArray<string> {
  return ["acp"];
}

/**
 * Arguments for the dependency probe. `hermes acp --check` imports `acp` and
 * `HermesACPAgent`, prints `Hermes ACP check OK`, and exits — without opening
 * a JSON-RPC session. It is the only way to tell "Hermes is installed" apart
 * from "Hermes is installed with the `[acp]` extra".
 */
export function hermesAcpCheckArgs(): ReadonlyArray<string> {
  return ["acp", "--check"];
}

function resolveHermesCommand(
  hermesSettings: Pick<HermesAcpRuntimeHermesSettings, "binaryPath"> | null | undefined,
): string {
  return hermesSettings?.binaryPath || "hermes";
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: resolveHermesCommand(hermesSettings),
    args: [...hermesAcpSpawnArgs()],
    cwd,
    env: buildHermesEnvironment({
      config: {
        homePath: hermesSettings?.homePath ?? "",
        skipConfiguredMcpServers: hermesSettings?.skipConfiguredMcpServers ?? false,
      },
      ...(environment ? { environment } : {}),
    }),
  };
}

/**
 * Build the ACP runtime for one Hermes session.
 *
 * Unlike Grok, no vendor decorator wraps the runtime: Hermes answers
 * `session/prompt` itself and emits no private completion notification, so the
 * standards-only runtime is complete on its own. Hermes' `_meta.hermes.*`
 * payloads are read passively in {@link ./HermesAcpExtension.ts} rather than
 * intercepted here.
 */
export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: HERMES_AUTH_METHOD_SETUP,
        // Hermes sends `raw_input: null` for every native tool and keeps the
        // command, the query and the target path in its title and start
        // content block instead. Without this the shared path has nothing to
        // build a work-log row from. See HermesToolCallAugment.
        toolCallAugment: hermesToolCallAugment,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

// ── Model selection ───────────────────────────────────────────────────

/**
 * Normalize a model id to the `<provider>:<model>` form Hermes expects.
 *
 * Hermes lowercases the provider half and leaves the model half alone
 * (`server.py _encode_model_choice`), and `parse_model_input` on the way back
 * in is case-insensitive about the provider. Normalizing here keeps a slug
 * that round-trips through settings identical to the one the catalog reports,
 * so a stored selection still matches after a restart.
 */
export function resolveHermesAcpBaseModelId(model: string | null | undefined): string {
  const normalized = normalizeModelSlug(model, HERMES_DRIVER_KIND);
  if (!normalized) {
    return HERMES_FALLBACK_MODEL_ID;
  }
  const separator = normalized.indexOf(":");
  if (separator <= 0 || separator === normalized.length - 1) {
    // A bare model name with no provider prefix. Hermes' `parse_model_input`
    // falls back to `detect_provider_for_model`, so pass it through untouched
    // rather than guessing a prefix that could route to the wrong endpoint.
    return normalized;
  }
  return `${normalized.slice(0, separator).toLowerCase()}${normalized.slice(separator)}`;
}

/** Human-facing label for a `<provider>:<model>` id, e.g. `openrouter · glm-5.2`. */
export function formatHermesModelLabel(modelId: string): string {
  const separator = modelId.indexOf(":");
  if (separator <= 0 || separator === modelId.length - 1) {
    return modelId;
  }
  return `${modelId.slice(0, separator)} · ${modelId.slice(separator + 1)}`;
}

type HermesSessionSetupResult =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

/** Read the model Hermes bound to a freshly created/loaded/resumed session. */
export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult: HermesSessionSetupResult,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Apply a requested model to a live Hermes session.
 *
 * `session/set_model` is an unstable ACP route; the runtime enables it via
 * `use_unstable_protocol`. Hermes rebuilds the agent when the provider half
 * changes, which drops the session's `base_url`/`api_mode` overrides — so this
 * deliberately no-ops when the requested id already matches, rather than
 * re-sending it on every turn.
 *
 * No `_meta` is sent: Hermes' `set_session_model` reads only `modelId`, and
 * its `ModelInfo` entries advertise no reasoning-effort options for a client
 * to echo back.
 */
export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const { requestedModelId, currentModelId } = input;
  if (requestedModelId === undefined || requestedModelId === currentModelId) {
    return Effect.succeed(currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}

// ── Session modes ─────────────────────────────────────────────────────

/**
 * Map T3's runtime mode onto a Hermes edit-approval mode.
 *
 * Hermes' three modes describe how *file edits* are gated
 * (`acp_adapter/edit_approval.py`):
 *
 * | mode           | policy              | behaviour                                    |
 * | -------------- | ------------------- | -------------------------------------------- |
 * | `default`      | `ask`               | prompt for every edit                        |
 * | `accept_edits` | `workspace_session` | auto-allow under cwd and the temp dir        |
 * | `dont_ask`     | `session`           | auto-allow anywhere                          |
 *
 * All three still prompt for sensitive paths — anything under `.git`/`.ssh`,
 * and `.env*` / `id_rsa` / `id_ed25519` basenames — and none of them affect
 * command execution, which always asks. `auto` maps to `accept_edits` rather
 * than `dont_ask` because T3's `auto` means "don't interrupt me inside the
 * workspace", not "touch anything on the machine".
 */
export function hermesModeIdForRuntimeMode(runtimeMode: RuntimeMode | undefined): string {
  switch (runtimeMode) {
    case "approval-required":
      return HERMES_MODE_DEFAULT;
    case "auto-accept-edits":
    case "auto":
      return HERMES_MODE_ACCEPT_EDITS;
    case "full-access":
      return HERMES_MODE_DONT_ASK;
    default:
      return HERMES_MODE_DEFAULT;
  }
}

/**
 * Pick the mode to request, given what the agent says it supports.
 *
 * Returns `undefined` when the request is already satisfied or when the agent
 * does not advertise the target mode — a `session/set_mode` for an unknown id
 * is silently coerced to `default` by Hermes, which would quietly *tighten*
 * permissions instead of failing loudly.
 */
export function resolveHermesModeSelection(input: {
  readonly modeState:
    | { readonly currentModeId: string; readonly availableModes: ReadonlyArray<{ id: string }> }
    | undefined;
  readonly runtimeMode: RuntimeMode | undefined;
}): string | undefined {
  const targetModeId = hermesModeIdForRuntimeMode(input.runtimeMode);
  const modeState = input.modeState;
  if (!modeState || modeState.currentModeId === targetModeId) {
    return undefined;
  }
  return modeState.availableModes.some((mode) => mode.id === targetModeId)
    ? targetModeId
    : undefined;
}

/**
 * Bring a live session's mode in line with the requested runtime mode.
 *
 * Hermes never emits `current_mode_update`, so the caller cannot learn the
 * result from the event stream — the resolved id is returned instead and the
 * adapter records it optimistically, exactly as the agent does internally.
 * The mode is also not persisted on Hermes' side (`SessionState._persist`
 * writes only cwd/provider/model), which is why it is re-applied on every
 * session start rather than trusted to survive a resume.
 *
 * Note the route: `setSessionMode` (a real `session/set_mode` request), not
 * the runtime's `setMode`, which drives a negotiated `mode` configuration
 * option. Hermes deliberately returns `configOptions: null` and advertises
 * `modes` instead (`acp_adapter/server.py:683` — Zed renders config options in
 * the model-picker slot), so the config-option path would validate against an
 * option that does not exist.
 */
export function applyHermesAcpSessionMode<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getModeState" | "setSessionMode"
  >;
  readonly runtimeMode: RuntimeMode | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const modeState = yield* input.runtime.getModeState;
    const targetModeId = resolveHermesModeSelection({
      modeState,
      runtimeMode: input.runtimeMode,
    });
    if (targetModeId === undefined) {
      return modeState?.currentModeId;
    }
    yield* input.runtime.setSessionMode(targetModeId).pipe(Effect.mapError(input.mapError));
    return targetModeId;
  });
}
