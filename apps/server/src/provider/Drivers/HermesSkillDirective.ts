/**
 * HermesSkillDirective — turn the composer's `$skill` token into something
 * Hermes acts on.
 *
 * T3's composer inserts `$<name> ` when a skill is picked
 * (`apps/web/src/components/chat/ChatComposer.tsx`), and the server sends the
 * prompt through verbatim. That works for Codex, which resolves `$name`
 * agent-side. **Hermes has no `$`-token syntax anywhere**, so the token
 * reaches the model as prose and a picked skill does nothing in particular.
 *
 * What Hermes does have is a `skill_view(name)` tool, present in the
 * `hermes-acp` toolset by default, plus a system-prompt catalog that already
 * instructs the model to load a relevant skill
 * (`agent/prompt_builder.py:build_skills_system_prompt`). So the cheapest
 * faithful bridge is to name the user's choice explicitly and let Hermes load
 * it through its own tool: progressive disclosure is preserved, the skill body
 * never passes through T3, and the load shows up in the worklog as a real
 * `skill view (<name>/SKILL.md)` tool row rather than as a claim by us.
 *
 * The alternative — reading the `SKILL.md` and inlining it — was rejected: it
 * spends context Hermes is designed not to spend, and it would put T3 in
 * charge of Hermes' own SKILL.md preprocessing (`${HERMES_SKILL_DIR}`
 * template variables, opt-in inline shell, skill bundles), which
 * `skill_view(preprocess=True)` already does correctly and will keep doing
 * across Hermes releases.
 *
 * This is a directive, not a mechanism: the model can decline. The directive
 * therefore tells it to stop and say so rather than carry on silently, which
 * is the failure mode a user can actually act on.
 *
 * @module provider/Drivers/HermesSkillDirective
 */

/**
 * The composer's own token grammar
 * (`packages/shared/src/composerInlineTokens.ts`), widened to also match a
 * token at the very end of the prompt. The composer appends a trailing space
 * when it inserts one, but a user who types the token by hand, or trims the
 * draft, produces the unterminated form — and `SkillInlineText.tsx` already
 * uses the `(?=\s|$)` variant for exactly that reason.
 *
 * `:` is legal inside a name so Hermes' qualified `plugin:skill` form
 * (`agent/skill_utils.py:parse_qualified_name`) survives.
 */
const SKILL_TOKEN_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

const FENCE_PATTERN = /^\s*(?:```|~~~)/;

/**
 * Blank out fenced blocks and inline code spans so a `$variable` inside a
 * shell snippet is never mistaken for a skill invocation. Lengths are
 * preserved to keep the masked text aligned with the original, which keeps
 * the scan trivially auditable.
 */
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
 * Skill names referenced by `$token` in a prompt, in first-appearance order
 * and deduplicated. Only names in `knownSkillNames` are returned: a bare `$5`
 * or a `$PATH` a user typed is left entirely alone, and so is a token naming
 * a skill this instance did not discover.
 *
 * Matching is exact first, then case-insensitive, because the composer always
 * inserts the catalog's own spelling but a hand-typed token may not.
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
 * The directive appended to the wire prompt, or `undefined` when the prompt
 * invokes no known skill.
 *
 * Bracketed and prefixed so it reads as harness metadata rather than as the
 * user speaking, matching how Hermes frames its own skill scaffolding
 * (`agent/skill_commands.py:build_skill_invocation_message` opens with
 * `[IMPORTANT: The user has invoked the "…" skill …]`). The user's own `$name`
 * text is left in place, so the composer chip and the stored message are
 * unchanged and the transcript still shows what they actually typed.
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

/**
 * Compose the text actually sent to Hermes: the user's prompt, then the
 * directive on its own paragraph. Returns the prompt unchanged when nothing
 * was invoked, so the non-skill path is byte-identical to before.
 */
export function applyHermesSkillDirective(
  promptText: string,
  knownSkillNames: ReadonlyArray<string>,
): string {
  const directive = buildHermesSkillDirective(promptText, knownSkillNames);
  return directive === undefined ? promptText : `${promptText}\n\n${directive}`;
}
