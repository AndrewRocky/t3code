import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

import { hermesTitleNamesDelegation, parseHermesDelegationHandle } from "./subagents.ts";

// Hermes builds a title per tool (`acp_adapter/tools.py` `build_tool_title`,
// `<tool>: <preview>`) and a start content block, and sends `raw_input` and
// `raw_output` only for unknown tools. The shared path reads `rawInput` and
// backtick titles, so it finds no command, exit code or MCP identity for
// Hermes' own tools.

/** `_START_CONTENT_BUILDERS["terminal"]` is `$ <command>`, untruncated. */
const SHELL_ECHO_PATTERN = /^\$[ \t]+(?<command>\S[\s\S]*)$/u;

/** `build_tool_title("terminal", …)` clips the command to 80 characters. */
const TERMINAL_TITLE_PATTERN = /^terminal:[ \t]+(?<command>\S.*)$/u;

/**
 * Terminal results go through `_format_generic_structured_result`
 * (`- **exit_code:** N`); `execute_code` writes `Exit code: N` and `process`
 * `- **Exit code:** N`.
 */
const EXIT_CODE_PATTERN =
  /^(?:- \*\*(?:exit_code|returncode|Exit code):\*\*|Exit code:)[ \t]*(?<code>-?\d+)[ \t]*$/mu;

/** The `output` field of a generic structured result, up to the next field bullet. */
const GENERIC_OUTPUT_PATTERN =
  /^- \*\*output:\*\* ?(?<output>[\s\S]*?)(?=\n- \*\*\w+:\*\*|$(?![\s\S]))/mu;

/**
 * The gateway renames editor MCP servers to `editor_<name>_<sha8>` per session
 * (`gateway/session_local_mcp.py` `_server_names`), so the model calls
 * `mcp__editor_t3_code_1a2b3c4d__preview_snapshot`. Restoring `mcp__<name>__`
 * lets the shared MCP identity match T3's own tools and label foreign ones.
 */
const GATEWAY_EDITOR_MCP_TITLE_PATTERN =
  /^mcp__editor_(?<server>[A-Za-z0-9_-]+?)_[0-9a-f]{8}__(?<rest>.+)$/su;

/**
 * Kinds the shared presentation turns into a fixed label ("Searched files",
 * "Ran command"). Without a detail the row loses what Hermes searched for or
 * ran, which Hermes' own title (`web search: <query>`, `python: <code>`) keeps.
 */
const FIXED_LABEL_KINDS = new Set(["execute", "read", "edit", "delete", "move", "search", "fetch"]);
const MAX_TITLE_DETAIL_CHARS = 160;

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next && next.length > 0 ? next : undefined;
}

function contentText(toolCall: AcpToolCallState): string | undefined {
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const inner = (entry as { content?: unknown }).content;
    const text =
      typeof inner === "object" && inner !== null ? (inner as { text?: unknown }).text : undefined;
    return typeof text === "string" && text.length > 0 ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function verbatimTitle(toolCall: AcpToolCallState): string | undefined {
  return typeof toolCall.data.title === "string" ? toolCall.data.title : toolCall.title;
}

function restoreMcpName(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const match = GATEWAY_EDITOR_MCP_TITLE_PATTERN.exec(title);
  const server = match?.groups?.server;
  const rest = match?.groups?.rest;
  return server && rest ? `mcp__${server}__${rest}` : undefined;
}

function recoverCommand(toolCall: AcpToolCallState): string | undefined {
  if (toolCall.kind !== "execute" || toolCall.command !== undefined) return undefined;
  const firstLine = trimmed(contentText(toolCall)?.split(/\r?\n/u, 1)[0]);
  const echoed = firstLine ? SHELL_ECHO_PATTERN.exec(firstLine)?.groups?.command : undefined;
  if (trimmed(echoed)) return trimmed(echoed);
  const title = verbatimTitle(toolCall);
  return trimmed(title ? TERMINAL_TITLE_PATTERN.exec(title)?.groups?.command : undefined);
}

/** A row that already names a command or a file keeps its own label. */
function recoverDetail(toolCall: AcpToolCallState): string | undefined {
  if (toolCall.kind === undefined || !FIXED_LABEL_KINDS.has(toolCall.kind)) return undefined;
  if (toolCall.detail !== undefined || toolCall.command !== undefined) return undefined;
  const locations = toolCall.data.locations;
  if (Array.isArray(locations) && locations.length > 0) return undefined;
  const title = trimmed(verbatimTitle(toolCall));
  if (title === undefined) return undefined;
  return title.length <= MAX_TITLE_DETAIL_CHARS
    ? title
    : `${title.slice(0, MAX_TITLE_DETAIL_CHARS - 1).trimEnd()}…`;
}

function isTerminal(toolCall: AcpToolCallState): boolean {
  return toolCall.status === "completed" || toolCall.status === "failed";
}

/**
 * The exit code goes into `rawOutput`, where the shared projection reads it,
 * together with the output text so the row keeps showing it.
 */
function recoverExitCode(
  toolCall: AcpToolCallState,
): { readonly exit_code: number; readonly output: string } | undefined {
  if (
    toolCall.kind !== "execute" ||
    !isTerminal(toolCall) ||
    toolCall.data.rawOutput !== undefined
  ) {
    return undefined;
  }
  const text = contentText(toolCall);
  const code = text === undefined ? undefined : EXIT_CODE_PATTERN.exec(text)?.groups?.code;
  if (text === undefined || code === undefined) return undefined;
  const output = GENERIC_OUTPUT_PATTERN.exec(text)?.groups?.output?.trimEnd();
  return { exit_code: Number.parseInt(code, 10), output: output ?? text };
}

/** The handle's JSON is model-facing; the row says what happened instead. */
function summarizeDelegation(toolCall: AcpToolCallState): string | undefined {
  if (!isTerminal(toolCall) || !hermesTitleNamesDelegation(verbatimTitle(toolCall))) {
    return undefined;
  }
  const dispatch = parseHermesDelegationHandle(contentText(toolCall));
  if (dispatch === undefined) return undefined;
  const started = dispatch.children.length;
  const lines = [
    `Started ${String(started)} subagent${started === 1 ? "" : "s"} in the background.`,
    ...dispatch.refused.map(
      (entry) =>
        `Task ${String(entry.taskIndex + 1)} was not started${entry.error ? `: ${entry.error}` : "."}`,
    ),
  ];
  return lines.join("\n");
}

export function normalizeHermesToolCall(toolCall: AcpToolCallState): AcpToolCallState {
  let next = toolCall;
  const restoredTitle = restoreMcpName(verbatimTitle(next));
  if (restoredTitle !== undefined) {
    const restoredSummary = restoreMcpName(next.title);
    next = {
      ...next,
      ...(restoredSummary === undefined ? {} : { title: restoredSummary }),
      data: { ...next.data, title: restoredTitle },
    };
  }
  const command = recoverCommand(next);
  if (command !== undefined) {
    next = { ...next, command, data: { ...next.data, command } };
  }
  const detail = recoverDetail(next);
  if (detail !== undefined) {
    next = { ...next, detail };
  }
  const delegationSummary = summarizeDelegation(next);
  if (delegationSummary !== undefined) {
    return {
      ...next,
      kind: "other",
      data: {
        ...next.data,
        kind: "other",
        content: [{ type: "content", content: { type: "text", text: delegationSummary } }],
      },
    };
  }
  const exit = recoverExitCode(next);
  if (exit !== undefined) {
    next = { ...next, data: { ...next.data, rawOutput: exit } };
  }
  return next;
}
