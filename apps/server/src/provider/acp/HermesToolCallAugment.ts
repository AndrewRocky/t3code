/**
 * HermesToolCallAugment — recover the tool-call facts Hermes puts somewhere
 * other than `rawInput`.
 *
 * Hermes' ACP adapter is written for a Markdown host. It builds a descriptive
 * title per tool (`hermes-agent:acp_adapter/tools.py` `_TITLE_BUILDERS`) and a
 * start content block per tool (`_START_CONTENT_BUILDERS`), and then sets
 * `raw_input=None` for every native tool — `raw_input` is populated only for an
 * unknown or plugin tool (`_build_tool_start`). `raw_output` is `None` for the
 * same set.
 *
 * The shared ACP path reads `rawInput` and nothing else, so for Hermes it finds
 * no command; `deriveToolActivityPresentation` then returns the bare summary
 * `"Ran command"` with no detail, because for a command tool the detail *is* the
 * command. A row with no command, no detail and no files has nothing to preview
 * and nothing to expand, which is what a Hermes work log looks like today.
 *
 * Everything here reads Hermes' own conventions, so it is wired only into
 * {@link makeHermesAcpRuntime}. Cursor and Grok fill `rawInput` in and never
 * reach this module.
 *
 * @module provider/acp/HermesToolCallAugment
 */
import type { AcpToolCallAugment, AcpToolCallAugmentInput } from "./AcpRuntimeModel.ts";

/**
 * Bound on the detail recovered from a title. Hermes already clips its own
 * titles (`terminal` at 80 chars, `delegate` at 60), so this only guards
 * against a future builder that does not.
 */
const MAX_RECOVERED_DETAIL_CHARS = 400;

/**
 * ACP tool kinds whose work-log row is classified by
 * `deriveToolActivityPresentation` into a fixed label. Only these lose the
 * agent's title; a tool of any other kind keeps its title as the row summary
 * already, so adding a detail there would just repeat it.
 */
const CLASSIFIED_KINDS = new Set(["execute", "read", "edit", "delete", "move", "search", "fetch"]);

/**
 * Kinds that actually change files. Changed-file paths are read ahead of every
 * other classification when the work log groups entries, so listing a read's
 * locations would label it a write.
 */
const FILE_CHANGING_KINDS = new Set(["edit", "delete", "move"]);

/** `_START_CONTENT_BUILDERS["terminal"]` is `f"$ {command}"`, untruncated. */
const SHELL_ECHO_PATTERN = /^\$[ \t]+(?<command>\S[\s\S]*)$/u;

/** `_TITLE_BUILDERS["terminal"]` is `f"terminal: {clip(command, 80)}"`. */
const TERMINAL_TITLE_PATTERN = /^terminal:[ \t]+(?<command>\S.*)$/u;

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next && next.length > 0 ? next : undefined;
}

function clamp(value: string): string {
  return value.length <= MAX_RECOVERED_DETAIL_CHARS
    ? value
    : `${value.slice(0, MAX_RECOVERED_DETAIL_CHARS - 1).trimEnd()}…`;
}

/**
 * Recover the command from Hermes' start content block, then from its title.
 *
 * The content block is preferred because Hermes writes the command into it
 * whole, while the title carries a copy clipped to 80 characters.
 */
function recoverCommand(input: AcpToolCallAugmentInput): string | undefined {
  if (input.kind !== "execute") {
    return undefined;
  }
  const firstLine = trimmed(input.text?.split(/\r?\n/u, 1)[0]);
  const echoed = firstLine ? SHELL_ECHO_PATTERN.exec(firstLine)?.groups?.command : undefined;
  if (trimmed(echoed)) {
    return trimmed(echoed);
  }
  const titled = input.title
    ? TERMINAL_TITLE_PATTERN.exec(input.title)?.groups?.command
    : undefined;
  return trimmed(titled);
}

/**
 * Hermes' own title, for a kind whose generic label would otherwise be the
 * whole row: `web search: effect-ts Layer`, `skill view (dataviz/SKILL.md)`,
 * `delegate: audit the ACP adapter`, `python: import pandas as pd`.
 *
 * Only used when the shared presentation found no detail of its own, so a
 * command it recovered or a path it read out of `locations` always wins.
 */
function recoverDetail(input: AcpToolCallAugmentInput): string | undefined {
  if (input.kind === undefined || !CLASSIFIED_KINDS.has(input.kind)) {
    return undefined;
  }
  const title = trimmed(input.title);
  return title ? clamp(title) : undefined;
}

/**
 * Ask the activity projection to keep the whole result block for this row.
 *
 * Hermes' completion content is a curated, already-bounded block — the exit
 * code, meaning and hint for a shell command, matched files with line numbers
 * for a search, headings for a skill, per-task summaries for a delegation
 * (`_COMPLETION_FORMATTERS`). The default projection keeps only its first line,
 * capped at 84 characters, which is enough for a collapsed row and nothing at
 * all when the row is expanded.
 *
 * Only terminal frames are marked. An in-flight frame's content is a start
 * echo (`$ <command>`, "Preparing write to …"), which the command and detail
 * already cover, and `tool.updated` rows are the ones that accumulate.
 */
function retainsFullOutput(input: AcpToolCallAugmentInput): boolean {
  return (
    (input.status === "completed" || input.status === "failed") &&
    input.text !== undefined &&
    input.text.trim().length > 0
  );
}

function recoverFiles(
  input: AcpToolCallAugmentInput,
): ReadonlyArray<{ readonly path: string }> | undefined {
  if (input.kind === undefined || !FILE_CHANGING_KINDS.has(input.kind)) {
    return undefined;
  }
  const paths: Array<{ readonly path: string }> = [];
  const seen = new Set<string>();
  for (const location of input.locations ?? []) {
    const path = trimmed(location.path);
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push({ path });
    }
  }
  return paths.length > 0 ? paths : undefined;
}

/**
 * Recover what Hermes carries outside `rawInput`.
 *
 * Returns `undefined` when there is nothing to add, so a tool call that already
 * parses well — an MCP or plugin call, where Hermes does send `rawInput` — is
 * left exactly as the shared path built it.
 */
export function hermesToolCallAugment(
  input: AcpToolCallAugmentInput,
): AcpToolCallAugment | undefined {
  const command = recoverCommand(input);
  const detail = recoverDetail(input);
  const files = recoverFiles(input);
  const retainFullOutput = retainsFullOutput(input);
  if (command === undefined && detail === undefined && files === undefined && !retainFullOutput) {
    return undefined;
  }
  return {
    ...(command !== undefined ? { command } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(retainFullOutput ? { data: { retainFullOutput: true } } : {}),
  };
}
