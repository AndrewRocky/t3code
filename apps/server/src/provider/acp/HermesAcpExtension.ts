/**
 * HermesAcpExtension — read-side support for Hermes' `_meta.hermes.*` payloads
 * and the ACP session updates the shared runtime model does not parse.
 *
 * Unlike `XAiAcpExtension`, nothing here decorates the runtime or answers a
 * private method: Hermes speaks standard ACP for every request. What it adds
 * is *information* on top of standard notifications, and three of its
 * notifications carry state T3 Code has canonical events for but
 * `AcpRuntimeModel` deliberately drops (it parses only the five turn-content
 * events every provider shares):
 *
 * - `usage_update` → `{ size, used }`, the live context-window ring
 *   (`acp_adapter/server.py _build_usage_update`).
 * - `session_info_update` → an auto-generated session title, plus session
 *   provenance when a mid-turn compression rotated Hermes' internal session.
 * - `available_commands_update` → the slash commands the adapter intercepts
 *   before they reach the model (`server.py _ADVERTISED_COMMANDS`).
 *
 * **Session provenance is the subtle one.** Hermes keeps the ACP session id
 * stable but rotates its *internal* session id when it compresses context
 * mid-turn. `_meta.hermes.sessionProvenance` is how a client learns that the
 * transcript it is showing now continues a different underlying session
 * (`acp_adapter/provenance.py`). We surface it as thread metadata so a resume
 * cursor and a compaction boundary stay explainable after the fact.
 *
 * Every parser here is total: an unexpected shape yields `undefined` or an
 * empty list rather than failing a turn, because none of this data is load
 * bearing for the conversation itself.
 *
 * @module provider/acp/HermesAcpExtension
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

/** Namespace Hermes uses for every vendor field it attaches to `_meta`. */
export const HERMES_META_NAMESPACE = "hermes";

/** Raw-source tag for events derived from Hermes' `_meta` payloads. */
export const HERMES_EXTENSION_SOURCE = "acp.hermes.extension" as const;

type SessionUpdate = EffectAcpSchema.SessionNotification["update"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/**
 * Coerce to a non-negative integer. Hermes reports context size and usage as
 * Python ints, but they arrive as JSON numbers and
 * `estimate_request_tokens_rough` is, as the name says, an estimate — so a
 * float or a negative is possible and must not reach a `NonNegativeInt`
 * schema.
 */
function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function hermesMeta(update: { readonly _meta?: unknown }): Record<string, unknown> | undefined {
  const meta = update._meta;
  if (!isRecord(meta)) {
    return undefined;
  }
  const namespaced = meta[HERMES_META_NAMESPACE];
  return isRecord(namespaced) ? namespaced : undefined;
}

// ── usage_update ──────────────────────────────────────────────────────

/**
 * Map Hermes' context-window telemetry onto T3's token-usage snapshot.
 *
 * Hermes sends `size` (the model's context length) and `used` (a rough token
 * estimate for history + system prompt + tool schemas). It is not per-turn
 * accounting: there is no input/output split and no cumulative total, so only
 * `usedTokens` and `maxTokens` are populated. `maxTokens` is dropped when it
 * is zero — `ThreadTokenUsageSnapshot.maxTokens` is a positive int, and a
 * provider with an unknown context length reports `0`.
 *
 * `compactsAutomatically` is asserted rather than read, because it is a fact
 * about the agent and not a field on the wire. Compression is the behaviour
 * Hermes is built around: `context_compressor` runs on its own threshold and
 * rotates the internal session id mid-turn when it fires, which is what
 * `_meta.hermes.sessionProvenance` exists to explain. Setting the flag is
 * what puts "Context … compacts automatically when needed." in the context
 * popover (`apps/web/src/components/chat/ContextWindowMeter.tsx`); without it
 * the panel says nothing about the one thing most worth knowing.
 * `autoCompactThreshold` stays absent deliberately — Hermes knows the number
 * (`/context` reports the distance to it) but `UsageUpdate` does not carry it,
 * and a guessed threshold would render as a precise claim.
 */
export function parseHermesUsageUpdate(
  update: SessionUpdate,
): ThreadTokenUsageSnapshot | undefined {
  if (update.sessionUpdate !== "usage_update") {
    return undefined;
  }
  const usedTokens = nonNegativeInt(update.used);
  if (usedTokens === undefined) {
    return undefined;
  }
  const maxTokens = nonNegativeInt(update.size);
  return {
    usedTokens,
    compactsAutomatically: true,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
  };
}

// ── session_info_update ───────────────────────────────────────────────

/**
 * Hermes session lineage, as reported by `acp_adapter/provenance.py`.
 *
 * `currentHermesSessionId` changes while `acpSessionId` stays fixed; the pair
 * is what makes a compaction boundary reconstructable from the event log.
 */
export interface HermesSessionProvenance {
  readonly acpSessionId?: string;
  readonly currentHermesSessionId?: string;
  readonly rootHermesSessionId?: string;
  readonly parentHermesSessionId?: string;
  readonly previousHermesSessionId?: string;
  readonly sessionKind?: string;
  readonly creatorKind?: string;
  readonly reason?: string;
  readonly compressionDepth?: number;
}

const PROVENANCE_STRING_KEYS = [
  "acpSessionId",
  "currentHermesSessionId",
  "rootHermesSessionId",
  "parentHermesSessionId",
  "previousHermesSessionId",
  "sessionKind",
  "creatorKind",
  "reason",
] as const;

/**
 * Extract `_meta.hermes.sessionProvenance` from any payload that carries a
 * `_meta` bag — the session setup responses and `session_info_update` both do.
 */
export function parseHermesSessionProvenance(payload: {
  readonly _meta?: unknown;
}): HermesSessionProvenance | undefined {
  const provenance = hermesMeta(payload)?.sessionProvenance;
  if (!isRecord(provenance)) {
    return undefined;
  }
  const parsed: Record<string, string | number> = {};
  for (const key of PROVENANCE_STRING_KEYS) {
    const value = nonEmptyString(provenance[key]);
    if (value !== undefined) {
      parsed[key] = value;
    }
  }
  const compressionDepth = nonNegativeInt(provenance.compressionDepth);
  if (compressionDepth !== undefined) {
    parsed.compressionDepth = compressionDepth;
  }
  return Object.keys(parsed).length > 0 ? (parsed as HermesSessionProvenance) : undefined;
}

export interface HermesSessionInfo {
  readonly title?: string;
  readonly updatedAt?: string;
  readonly provenance?: HermesSessionProvenance;
}

/**
 * Parse `session_info_update`. Hermes sends it twice for different reasons:
 * once when it auto-titles a session from the first exchange, and again with
 * provenance attached when compression rotated the internal session mid-turn.
 * Returns `undefined` when neither a title nor provenance is present, so a
 * bare timestamp refresh does not churn thread metadata.
 */
export function parseHermesSessionInfo(update: SessionUpdate): HermesSessionInfo | undefined {
  if (update.sessionUpdate !== "session_info_update") {
    return undefined;
  }
  const title = nonEmptyString(update.title);
  const updatedAt = nonEmptyString(update.updatedAt);
  const provenance = parseHermesSessionProvenance(update);
  if (title === undefined && provenance === undefined) {
    return undefined;
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

/**
 * True when a replayed history chunk is (or contains) a compaction summary.
 *
 * Hermes marks these so a client can collapse the handoff text instead of
 * showing it as ordinary assistant output (`server.py:1402`).
 */
export function hermesUpdateCarriesCompactionSummary(update: SessionUpdate): boolean {
  const meta = hermesMeta(update);
  return meta?.compactionSummary === true || meta?.containsCompactionSummary === true;
}

// ── available_commands_update ─────────────────────────────────────────

export interface HermesAvailableCommand {
  readonly name: string;
  readonly description?: string;
  readonly hint?: string;
}

/**
 * Parse the slash-command catalog. Hermes intercepts these itself when a
 * prompt is text-only, so they never reach the model — surfacing them lets the
 * composer offer the same completions the Hermes TUI does.
 */
export function parseHermesAvailableCommands(
  update: SessionUpdate,
): ReadonlyArray<HermesAvailableCommand> {
  if (update.sessionUpdate !== "available_commands_update") {
    return [];
  }
  const commands: Array<HermesAvailableCommand> = [];
  for (const entry of update.availableCommands) {
    const name = nonEmptyString(entry.name);
    if (name === undefined) {
      continue;
    }
    const description = nonEmptyString(entry.description);
    const input = entry.input;
    const hint = isRecord(input) ? nonEmptyString(input.hint) : undefined;
    commands.push({
      name,
      ...(description !== undefined ? { description } : {}),
      ...(hint !== undefined ? { hint } : {}),
    });
  }
  return commands;
}
