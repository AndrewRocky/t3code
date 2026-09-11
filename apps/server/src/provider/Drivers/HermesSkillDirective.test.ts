import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  applyHermesSkillDirective,
  buildHermesSkillDirective,
  findInvokedHermesSkillNames,
} from "./HermesSkillDirective.ts";

const KNOWN = ["pdf", "xlsx", "memory-curator", "superpowers:writing-plans"];

describe("findInvokedHermesSkillNames", () => {
  it("finds a token the composer inserted, trailing space and all", () => {
    assert.deepStrictEqual([...findInvokedHermesSkillNames("$pdf summarise this", KNOWN)], ["pdf"]);
  });

  it("finds a token at the very end of the prompt", () => {
    // The composer appends a space, but a trimmed draft or a hand-typed
    // token produces the unterminated form.
    assert.deepStrictEqual([...findInvokedHermesSkillNames("use $pdf", KNOWN)], ["pdf"]);
  });

  it("keeps first-appearance order and deduplicates", () => {
    assert.deepStrictEqual(
      [...findInvokedHermesSkillNames("$xlsx then $pdf then $xlsx again", KNOWN)],
      ["xlsx", "pdf"],
    );
  });

  it("resolves a qualified plugin name", () => {
    assert.deepStrictEqual(
      [...findInvokedHermesSkillNames("$superpowers:writing-plans go", KNOWN)],
      ["superpowers:writing-plans"],
    );
  });

  it("matches case-insensitively but reports the catalog's spelling", () => {
    assert.deepStrictEqual(
      [...findInvokedHermesSkillNames("$Memory-Curator please", KNOWN)],
      ["memory-curator"],
    );
  });

  it("ignores tokens that are not known skills", () => {
    // A shell variable, a price, and a skill this instance never discovered.
    assert.deepStrictEqual(
      [...findInvokedHermesSkillNames("echo $PATH costs $5 and $not-installed", KNOWN)],
      [],
    );
  });

  it("ignores a token inside a fenced block or an inline code span", () => {
    const prompt = ["run this:", "```sh", "echo $pdf", "```", "and `$xlsx` is literal"].join("\n");
    assert.deepStrictEqual([...findInvokedHermesSkillNames(prompt, KNOWN)], []);
  });

  it("still finds a token outside a fence in the same prompt", () => {
    const prompt = ["$pdf do it", "```sh", "echo $xlsx", "```"].join("\n");
    assert.deepStrictEqual([...findInvokedHermesSkillNames(prompt, KNOWN)], ["pdf"]);
  });

  it("requires a boundary before the token", () => {
    // `cost$pdf` is not an invocation; the composer's own grammar agrees.
    assert.deepStrictEqual([...findInvokedHermesSkillNames("cost$pdf now", KNOWN)], []);
  });

  it("returns nothing for an empty catalog or a prompt with no token", () => {
    assert.deepStrictEqual([...findInvokedHermesSkillNames("$pdf", [])], []);
    assert.deepStrictEqual([...findInvokedHermesSkillNames("no tokens here", KNOWN)], []);
  });
});

describe("buildHermesSkillDirective", () => {
  it("names the skill, the tool call, and the failure instruction", () => {
    const directive = buildHermesSkillDirective("$pdf summarise", KNOWN);
    assert.isDefined(directive);
    assert.include(directive ?? "", 'the user invoked the "pdf" skill');
    assert.include(directive ?? "", 'skill_view("pdf")');
    // The model can decline; it must say so rather than continue silently.
    assert.include(directive ?? "", "stop and tell the user");
  });

  it("chains multiple invocations in order", () => {
    const directive = buildHermesSkillDirective("$xlsx and $pdf", KNOWN) ?? "";
    assert.include(directive, 'skill_view("xlsx") then skill_view("pdf")');
    assert.include(directive, "skills");
  });

  it("is undefined when no known skill is invoked", () => {
    assert.isUndefined(buildHermesSkillDirective("just a prompt", KNOWN));
  });
});

describe("applyHermesSkillDirective", () => {
  it("keeps the user's text and appends the directive", () => {
    const applied = applyHermesSkillDirective("$pdf summarise", KNOWN);
    assert.isTrue(applied.startsWith("$pdf summarise\n\n"));
    assert.include(applied, 'skill_view("pdf")');
  });

  it("returns the prompt byte-identical when nothing is invoked", () => {
    // The non-skill path must be unchanged from before this existed.
    const prompt = "refactor the parser and run the tests";
    assert.equal(applyHermesSkillDirective(prompt, KNOWN), prompt);
  });
});
