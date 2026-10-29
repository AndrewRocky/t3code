// The composer's `$skill` token means nothing to Hermes, but its system prompt
// tells the model to load skills with `skill_view(name)`. Naming the choice lets
// Hermes load it itself, shown as a real tool row.

/**
 * The composer's token grammar (`composerInlineTokens.ts`), widened to match
 * at the end of the prompt. `:` keeps Hermes' qualified `plugin:skill` form.
 */
const SKILL_TOKEN_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

const FENCE_PATTERN = /^\s*(?:```|~~~)/;

/** A `$variable` in a code fence or span is never a skill invocation; lengths are kept. */
function maskCodeRegions(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  const masked = lines.map((line) => {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      return " ".repeat(line.length);
    }
    if (inFence) {
      return " ".repeat(line.length);
    }
    return line.replaceAll(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
  });
  return masked.join("\n");
}

/**
 * Known skill names referenced by `$token`, deduplicated in order. Exact match
 * first, then case-insensitive, since a hand-typed token may differ in case.
 */
export function findInvokedHermesSkillNames(
  promptText: string,
  knownSkillNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (knownSkillNames.length === 0 || !promptText.includes("$")) {
    return [];
  }

  const exact = new Set(knownSkillNames);
  const byLowercase = new Map<string, string>();
  for (const name of knownSkillNames) {
    const key = name.toLowerCase();
    if (!byLowercase.has(key)) {
      byLowercase.set(key, name);
    }
  }

  const invoked: Array<string> = [];
  const seen = new Set<string>();
  for (const match of maskCodeRegions(promptText).matchAll(SKILL_TOKEN_PATTERN)) {
    const token = match[2];
    if (token === undefined) {
      continue;
    }
    const resolved = exact.has(token) ? token : byLowercase.get(token.toLowerCase());
    if (resolved === undefined || seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    invoked.push(resolved);
  }
  return invoked;
}

function formatSkillList(names: ReadonlyArray<string>): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * Bracketed like Hermes' own skill scaffolding
 * (`agent/skill_commands.py:build_skill_invocation_message`) so it reads as
 * harness metadata. The user's `$name` text stays in place.
 */
export function buildHermesSkillDirective(
  promptText: string,
  knownSkillNames: ReadonlyArray<string>,
): string | undefined {
  const invoked = findInvokedHermesSkillNames(promptText, knownSkillNames);
  if (invoked.length === 0) {
    return undefined;
  }

  const isPlural = invoked.length > 1;
  const calls = invoked.map((name) => `skill_view("${name}")`).join(" then ");
  return [
    `[T3 Code: the user invoked the ${formatSkillList(invoked)} skill${isPlural ? "s" : ""}.`,
    `Call ${calls} before doing anything else and follow ${isPlural ? "those instructions" : "its instructions"}.`,
    `If ${isPlural ? "any of them" : "it"} cannot be loaded, stop and tell the user which skill is unavailable instead of continuing without it.]`,
  ].join(" ");
}

/** The prompt, then the directive on its own paragraph; unchanged when nothing was invoked. */
export function applyHermesSkillDirective(
  promptText: string,
  knownSkillNames: ReadonlyArray<string>,
): string {
  const directive = buildHermesSkillDirective(promptText, knownSkillNames);
  return directive === undefined ? promptText : `${promptText}\n\n${directive}`;
}
