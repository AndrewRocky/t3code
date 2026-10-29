// @effect-diagnostics nodeBuiltinImport:off
// Hermes shares a file by writing `MEDIA:/absolute/path` in its reply; its
// messaging gateway turns those into attachments, its ACP layer does not. T3
// already renders a Markdown image with an absolute-path source on every
// client, so Hermes' reply text is rewritten to `![name](/path)`.
//
// Which tags count follows Hermes' gateway (`gateway/platforms/base.py`
// `MEDIA_TAG_CLEANUP_RE`, `_mask_protected_spans`): anchored paths, bare or
// quoted; never inside fenced code, inline code or a blockquote, except a tag
// that is a whole inline code span (delivered only when the file exists);
// only images and videos. The keyword must be upper-case. A tag can be split
// across stream chunks, so the rest of a line is held from the first possible
// tag to its newline; a line with no tag is never delayed.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";

/**
 * Every extension Hermes' gateway delivers (`MEDIA_DELIVERY_EXTS`). The
 * matcher needs all of them, not only the ones T3 renders: a path ends at the
 * first deliverable extension, so `MEDIA:/a.pdf and b.png` is one PDF tag
 * followed by prose, not a single image path.
 */
const HERMES_MEDIA_DELIVERY_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "svg",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "3gp",
  "mp3",
  "m2a",
  "wav",
  "ogg",
  "opus",
  "m4a",
  "flac",
  "pdf",
  "docx",
  "doc",
  "odt",
  "rtf",
  "txt",
  "md",
  "epub",
  "xlsx",
  "xls",
  "ods",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "kmz",
  "kml",
  "geojson",
  "gpx",
  "pptx",
  "ppt",
  "odp",
  "key",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "apk",
  "ipa",
  "html",
  "htm",
] as const;

const KEYWORD = "MEDIA:";

/** Full-width punctuation Hermes accepts as the end of a path. */
const CJK_TERMINATORS = "（）〈〉《》：，。；！？、\u201c\u201d\u2018\u2019【】";

const EXTENSION_ALTERNATION = [...HERMES_MEDIA_DELIVERY_EXTENSIONS]
  .toSorted((left, right) => right.length - left.length)
  .join("|");

/**
 * `MEDIA_TAG_CLEANUP_RE`, minus the emphasis or quote markers it allows
 * around the tag: those stay in the text, so `**MEDIA:/x.png**` becomes a bold
 * image rather than losing half its markers. Case-insensitive for the
 * extension; the keyword itself is checked separately.
 */
const MEDIA_TAG_PATTERN = new RegExp(
  "MEDIA:\\s*(?<path>`[^`\\n]+?`|\"[^\"\\n]+?\"|'[^'\\n]+?'|" +
    "(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:" +
    EXTENSION_ALTERNATION +
    "))" +
    "(?=[\\s`\"'*_,;:)\\]}\\[" +
    CJK_TERMINATORS +
    "]|MEDIA:|\\.(?:\\s|$)|$)",
  "gi",
);

/** Hermes' `_INLINE_CODE_RE`: a single-backtick span on one line. */
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const BLOCKQUOTE_PATTERN = /^ {0,3}>/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[/\\]/;

export interface HermesMediaTagOptions {
  /** Directory a `~/` path is relative to; Hermes expands it the same way. */
  readonly homeDir: string;
  /**
   * Whether a path names an existing file. Consulted only for a tag that is
   * the whole of an inline code span, the one form Hermes checks on disk
   * before delivering: a model uses it both for real files and for examples.
   */
  readonly isFile: (path: string) => boolean;
}

/** The host the Hermes process runs on, which is the host T3 serves files from. */
export const hostHermesMediaTagOptions: HermesMediaTagOptions = {
  homeDir: NodeOS.homedir(),
  isFile: (path) => {
    try {
      return NodeFS.statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

export interface HermesMediaTagStream {
  /** Takes the next chunk of one reply and returns the text that can be shown now. */
  readonly push: (text: string) => string;
  /** Ends the reply and returns everything still held back. */
  readonly flush: () => string;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Fence {
  readonly marker: string;
  readonly length: number;
}

/** Hermes' `_normalize_media_tag_path`. */
function normalizeTagPath(raw: string): string {
  let path = raw.trim();
  if (path.length >= 2 && path[0] === path.at(-1) && "`\"'".includes(path[0]!)) {
    path = path.slice(1, -1).trim();
  }
  return path.replace(/^[`"']+/, "").replace(/[`"',.;:)}\]]+$/, "");
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * A link destination the client resolves back to `path`. The client splits
 * on `#` and `?` and then percent-decodes (`markdownImages.ts`), so encoding
 * is the form that survives every character a filename can hold.
 */
function encodeDestination(path: string): string | undefined {
  try {
    return encodeURI(path).replace(/[#?()]/g, (character) =>
      character === "#" ? "%23" : character === "?" ? "%3F" : character === "(" ? "%28" : "%29",
    );
  } catch {
    // A lone surrogate cannot be encoded; leave the tag as Hermes wrote it.
    return undefined;
  }
}

function toMarkdownImage(
  rawPath: string,
  options: HermesMediaTagOptions,
  requireFile: boolean,
): string | undefined {
  const normalized = normalizeTagPath(rawPath);
  const path = normalized.startsWith("~/")
    ? NodePath.join(options.homeDir, normalized.slice(2))
    : normalized;
  if (!path.startsWith("/") && !WINDOWS_DRIVE_PATTERN.test(path)) return undefined;
  const name = basename(path);
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex <= 0) return undefined;
  if (mediaMimeTypeFromExtension(name.slice(extensionIndex)) === null) return undefined;
  if (requireFile && !options.isFile(path)) return undefined;
  const destination = encodeDestination(path);
  if (destination === undefined) return undefined;
  return `![${name.replace(/[\\[\]]/g, "\\$&")}](${destination})`;
}

function findReplacements(line: string, options: HermesMediaTagOptions): Replacement[] {
  const replacements: Replacement[] = [];
  const masked: Array<readonly [number, number]> = [];
  for (const span of line.matchAll(INLINE_CODE_PATTERN)) {
    const start = span.index;
    const end = start + span[0].length;
    // A backtick right after the keyword quotes a path; it is not code.
    if (/MEDIA:\s*$/i.test(line.slice(Math.max(0, start - 20), start))) continue;
    const inner = span[0].slice(1, -1).trim();
    const image = inner.startsWith(KEYWORD)
      ? toMarkdownImage(inner.slice(KEYWORD.length), options, true)
      : undefined;
    if (image !== undefined) replacements.push({ start, end, text: image });
    masked.push([start, end]);
  }
  for (const match of line.matchAll(MEDIA_TAG_PATTERN)) {
    const start = match.index;
    if (!line.startsWith(KEYWORD, start)) continue;
    if (masked.some(([from, to]) => start >= from && start < to)) continue;
    const image = toMarkdownImage(match.groups?.path ?? "", options, false);
    if (image !== undefined) {
      replacements.push({ start, end: start + match[0].length, text: image });
    }
  }
  return replacements.toSorted((left, right) => left.start - right.start);
}

/**
 * Whether the text from `start`, just after a keyword, is the start of a
 * tag's path. `undecided` until enough of it has arrived to tell; `false`
 * for prose that happens to say `MEDIA:`, which is shown rather than held.
 */
function startsTagPath(text: string, start: number): boolean | "undecided" {
  let index = start;
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  const [first, second, third] = [text[index], text[index + 1], text[index + 2]];
  if (first === undefined) return "undecided";
  if ("`\"'/".includes(first)) return true;
  if (first === "~") return second === undefined ? "undecided" : second === "/";
  if (!/[A-Za-z]/.test(first)) return false;
  if (second === undefined) return "undecided";
  if (second !== ":") return false;
  return third === undefined ? "undecided" : "/\\".includes(third);
}

interface HoldPoint {
  /** How much of the unshown text can be shown now. */
  readonly end: number;
  /** A tag has started, so the rest of the line is held without looking again. */
  readonly settled: boolean;
}

/**
 * Where an unfinished line's unshown part stops: the first possible tag, a cut-off
 * keyword, or a backtick that may open a code span around a tag, unless shown.
 * `codeSpanOpen`: a code span opened earlier in the line is still open.
 */
function holdPoint(text: string, codeSpanOpen: boolean): HoldPoint {
  /** The opening backtick, in `text`, of a code span still open at `end`; -1 if none. */
  const openCodeSpanAt = (end: number) => {
    let open = codeSpanOpen ? -2 : -1;
    for (let index = 0; index < end; index += 1) {
      if (text[index] === "`") open = open === -1 ? index : -1;
    }
    return Math.max(open, -1);
  };
  for (let index = text.indexOf(KEYWORD); index !== -1; index = text.indexOf(KEYWORD, index + 1)) {
    const path = startsTagPath(text, index + KEYWORD.length);
    if (path === false) continue;
    const codeSpanStart = openCodeSpanAt(index);
    return { end: codeSpanStart === -1 ? index : codeSpanStart, settled: path === true };
  }
  for (let length = KEYWORD.length - 1; length > 0; length -= 1) {
    if (text.endsWith(KEYWORD.slice(0, length))) {
      const index = text.length - length;
      const codeSpanStart = openCodeSpanAt(index);
      return { end: codeSpanStart === -1 ? index : codeSpanStart, settled: false };
    }
  }
  // A code span opened by nothing but whitespace so far may still turn out
  // to wrap a tag; anything else shows now.
  const open = openCodeSpanAt(text.length);
  if (open !== -1 && text.slice(open + 1).trim().length === 0) {
    return { end: open, settled: false };
  }
  let end = text.length;
  while (end > 0 && text[end - 1] === "`") end -= 1;
  return { end, settled: false };
}

/**
 * Enough of a line's start to tell whether it opens or closes a fence or is
 * a blockquote. A closing fence is never longer than this in practice.
 */
const LINE_HEAD_LENGTH = 64;

export function makeHermesMediaTagStream(options: HermesMediaTagOptions): HermesMediaTagStream {
  // Only the unshown part of the current line is kept, so a long line costs
  // the same per chunk as a short one.
  let head = "";
  let lineLength = 0;
  let unshown = "";
  let codeSpanOpen = false;
  let holdingLine = false;
  let fence: Fence | undefined;

  const show = (text: string) => {
    for (const character of text) {
      if (character === "`") codeSpanOpen = !codeSpanOpen;
    }
    return text;
  };

  /** Rest of the current line, rewritten, now that the whole line is known. */
  const finishLine = (): string => {
    const text = unshown;
    const lineHead = head;
    const isWholeLine = lineLength <= LINE_HEAD_LENGTH;
    const spanOpen = codeSpanOpen;
    head = "";
    lineLength = 0;
    unshown = "";
    codeSpanOpen = false;
    holdingLine = false;
    if (fence !== undefined) {
      const marker = fence.marker === "`" ? "`" : "~";
      const close = new RegExp(`^ {0,3}${marker}{${fence.length},}\\s*$`);
      if (isWholeLine && close.test(lineHead)) fence = undefined;
      return text;
    }
    const open = FENCE_OPEN_PATTERN.exec(lineHead);
    if (open !== null) {
      fence = { marker: open[1]![0]!, length: open[1]!.length };
      return text;
    }
    if (BLOCKQUOTE_PATTERN.test(lineHead)) return text;
    // A code span opened in the shown part still pairs with the first
    // backtick here; a stand-in opener keeps the pairing right.
    const offset = spanOpen ? 1 : 0;
    const scanned = spanOpen ? `\`${text}` : text;
    let output = "";
    let position = offset;
    for (const replacement of findReplacements(scanned, options)) {
      // A replacement that would start in text already shown is left as
      // written; the hold point makes that the stand-in opener's case only.
      if (replacement.start < position) continue;
      output += scanned.slice(position, replacement.start) + replacement.text;
      position = replacement.end;
    }
    return output + scanned.slice(position);
  };

  /** The part of the unfinished line that can no longer turn into a tag. */
  const releaseUnfinished = (): string => {
    if (holdingLine) return "";
    if (fence !== undefined || BLOCKQUOTE_PATTERN.test(head)) {
      const released = unshown;
      unshown = "";
      return show(released);
    }
    const hold = holdPoint(unshown, codeSpanOpen);
    holdingLine = hold.settled;
    const released = unshown.slice(0, hold.end);
    unshown = unshown.slice(hold.end);
    return show(released);
  };

  const append = (text: string) => {
    if (head.length < LINE_HEAD_LENGTH) head += text.slice(0, LINE_HEAD_LENGTH - head.length);
    lineLength += text.length;
    unshown += text;
  };

  return {
    push: (text) => {
      let output = "";
      let rest = text;
      for (let newline = rest.indexOf("\n"); newline !== -1; newline = rest.indexOf("\n")) {
        append(rest.slice(0, newline));
        output += `${finishLine()}\n`;
        rest = rest.slice(newline + 1);
      }
      append(rest);
      return output + releaseUnfinished();
    },
    flush: () => {
      const output = lineLength > 0 ? finishLine() : "";
      fence = undefined;
      return output;
    },
  };
}

/** Rewrites one complete reply; the streaming form is {@link makeHermesMediaTagStream}. */
export function rewriteHermesMediaTags(text: string, options: HermesMediaTagOptions): string {
  const stream = makeHermesMediaTagStream(options);
  return stream.push(text) + stream.flush();
}
