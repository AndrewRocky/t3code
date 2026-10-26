import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  type HermesMediaTagOptions,
  makeHermesMediaTagStream,
  rewriteHermesMediaTags,
} from "./mediaTags.ts";

const existing = new Set(["/tmp/real.png"]);
const options: HermesMediaTagOptions = {
  homeDir: "/home/me",
  isFile: (path) => existing.has(path),
};

const rewrite = (text: string) => rewriteHermesMediaTags(text, options);

/** Feeds `text` in pieces of `size` characters and returns what was shown, in order. */
const streamInPieces = (text: string, size: number) => {
  const stream = makeHermesMediaTagStream(options);
  let shown = "";
  for (let index = 0; index < text.length; index += size) {
    shown += stream.push(text.slice(index, index + size));
  }
  return shown + stream.flush();
};

describe("rewriteHermesMediaTags", () => {
  it("turns a tag on its own line into an image", () => {
    assert.equal(
      rewrite("Here is the page:\nMEDIA:/tmp/hermes/img_1.png\nLooks fine."),
      "Here is the page:\n![img_1.png](/tmp/hermes/img_1.png)\nLooks fine.",
    );
  });

  it("ends the path where Hermes does, keeping sentence punctuation", () => {
    assert.equal(rewrite("Saved as MEDIA:/tmp/a.png."), "Saved as ![a.png](/tmp/a.png).");
    assert.equal(rewrite("(see MEDIA:/tmp/a.png)"), "(see ![a.png](/tmp/a.png))");
  });

  it("keeps the emphasis a model wraps around the tag", () => {
    assert.equal(rewrite("**MEDIA:/tmp/a.png**"), "**![a.png](/tmp/a.png)**");
  });

  it("renders a video with the same image syntax T3 already plays", () => {
    assert.equal(rewrite("MEDIA:/tmp/run.mp4"), "![run.mp4](/tmp/run.mp4)");
    assert.equal(rewrite("MEDIA:/tmp/run.webm"), "![run.webm](/tmp/run.webm)");
  });

  it("accepts a path with spaces, bare or quoted, and encodes it", () => {
    const expected = "![my shot.png](/tmp/my%20shot.png)";
    assert.equal(rewrite("MEDIA:/tmp/my shot.png"), expected);
    assert.equal(rewrite('MEDIA: "/tmp/my shot.png"'), expected);
    assert.equal(rewrite("MEDIA:`/tmp/my shot.png`"), expected);
  });

  it("encodes the characters the client would otherwise split or decode", () => {
    const output = rewrite("MEDIA:/tmp/a#1?(2)%.png");
    assert.equal(output, "![a#1?(2)%.png](/tmp/a%231%3F%282%29%25.png)");
    const destination = /\]\((.*)\)$/.exec(output)?.[1] ?? "";
    assert.equal(decodeURIComponent(destination), "/tmp/a#1?(2)%.png");
  });

  it("escapes brackets in the alt text", () => {
    assert.equal(rewrite("MEDIA:/tmp/[draft].png"), "![\\[draft\\].png](/tmp/%5Bdraft%5D.png)");
  });

  it("expands a home-relative path the way Hermes does", () => {
    assert.equal(rewrite("MEDIA:~/shots/a.png"), "![a.png](/home/me/shots/a.png)");
  });

  it("accepts a Windows drive path", () => {
    assert.equal(rewrite("MEDIA:C:\\Users\\me\\a.png"), "![a.png](C:%5CUsers%5Cme%5Ca.png)");
  });

  it("rewrites every tag on a line, including glued ones", () => {
    assert.equal(
      rewrite("MEDIA:/tmp/a.png and MEDIA:/tmp/b.jpg"),
      "![a.png](/tmp/a.png) and ![b.jpg](/tmp/b.jpg)",
    );
    assert.equal(
      rewrite("MEDIA:/tmp/a.pngMEDIA:/tmp/b.png"),
      "![a.png](/tmp/a.png)![b.png](/tmp/b.png)",
    );
  });

  it("leaves a file T3 cannot show inline exactly as Hermes wrote it", () => {
    assert.equal(rewrite("MEDIA:/tmp/report.pdf"), "MEDIA:/tmp/report.pdf");
    assert.equal(rewrite("MEDIA:/tmp/voice.ogg"), "MEDIA:/tmp/voice.ogg");
    // The path ends at the PDF, as in Hermes; the later `.png` is prose.
    assert.equal(rewrite("MEDIA:/tmp/a.pdf and b.png"), "MEDIA:/tmp/a.pdf and b.png");
  });

  it("leaves anything that is not an absolute path", () => {
    assert.equal(rewrite("MEDIA:shot.png"), "MEDIA:shot.png");
    assert.equal(
      rewrite("MEDIA: is how Hermes shares files."),
      "MEDIA: is how Hermes shares files.",
    );
    assert.equal(rewrite('MEDIA: "shot.png"'), 'MEDIA: "shot.png"');
  });

  it("only treats the upper-case keyword as a tag", () => {
    assert.equal(rewrite("social media:/tmp/a.png"), "social media:/tmp/a.png");
  });

  it("leaves tags inside fenced code and blockquotes alone", () => {
    const text = [
      "```",
      "MEDIA:/tmp/a.png",
      "```",
      "~~~~",
      "MEDIA:/tmp/a.png",
      "```",
      "~~~~",
      "> MEDIA:/tmp/a.png",
      "MEDIA:/tmp/a.png",
    ].join("\n");
    assert.equal(
      rewrite(text),
      [
        "```",
        "MEDIA:/tmp/a.png",
        "```",
        "~~~~",
        "MEDIA:/tmp/a.png",
        "```",
        "~~~~",
        "> MEDIA:/tmp/a.png",
        "![a.png](/tmp/a.png)",
      ].join("\n"),
    );
  });

  it("leaves a tag that is only part of an inline code span alone", () => {
    assert.equal(
      rewrite("Write `MEDIA:/tmp/real.png and more` to share."),
      "Write `MEDIA:/tmp/real.png and more` to share.",
    );
  });

  it("shows a tag that is a whole code span only when the file exists", () => {
    assert.equal(rewrite("Done: `MEDIA:/tmp/real.png`"), "Done: ![real.png](/tmp/real.png)");
    assert.equal(rewrite("e.g. `MEDIA:/path/to/file.png`"), "e.g. `MEDIA:/path/to/file.png`");
  });
});

describe("makeHermesMediaTagStream", () => {
  const samples = [
    "Here is the page:\nMEDIA:/tmp/hermes/img_1.png\nLooks fine.",
    "Saved as **MEDIA:/tmp/my shot.png**. Next, MEDIA:/tmp/report.pdf too.",
    "```md\nMEDIA:/tmp/a.png\n```\nDone: `MEDIA:/tmp/real.png` and ` MEDIA:/tmp/real.png`",
    "The MEDIA: convention is Hermes'. MEDIA:~/a.png\n> MEDIA:/tmp/a.png\nend",
    "trailing tag with no newline MEDIA:/tmp/z.webp",
    "Run `npm run shot` first, then MEDIA:/tmp/a.png and `x` MEDIA:/tmp/b.png",
    "MEDIA: Convention, not a tag. MEDIA: ~nope either, but MEDIA:C:/shots/c.png is",
  ];

  it("shows the same text however the reply is chunked", () => {
    for (const sample of samples) {
      const whole = rewrite(sample);
      for (const size of [1, 2, 3, 5, 7, 11, 64]) {
        assert.equal(streamInPieces(sample, size), whole, `chunk size ${size}: ${sample}`);
      }
    }
  });

  it("shows text before a possible tag at once and holds only the rest of that line", () => {
    const stream = makeHermesMediaTagStream(options);
    assert.equal(stream.push("Here is the shot: MED"), "Here is the shot: ");
    assert.equal(stream.push("IA:/tmp/a.png and"), "");
    assert.equal(stream.push(" more\nNext"), "![a.png](/tmp/a.png) and more\nNext");
    assert.equal(stream.flush(), "");
  });

  it("never delays a line without a tag", () => {
    const stream = makeHermesMediaTagStream(options);
    assert.equal(stream.push("hello wor"), "hello wor");
    assert.equal(stream.push("ld, no media here"), "ld, no media here");
  });

  it("releases prose that only mentions the keyword as soon as it cannot be a tag", () => {
    const stream = makeHermesMediaTagStream(options);
    assert.equal(stream.push("The MEDIA: "), "The ");
    assert.equal(stream.push("convention"), "MEDIA: convention");
  });

  it("returns a held tag when the reply ends without a newline", () => {
    const stream = makeHermesMediaTagStream(options);
    assert.equal(stream.push("Done. MEDIA:/tmp/a.png"), "Done. ");
    assert.equal(stream.flush(), "![a.png](/tmp/a.png)");
  });

  it("streams fenced code untouched and without delay", () => {
    const stream = makeHermesMediaTagStream(options);
    assert.equal(stream.push("```\n"), "```\n");
    assert.equal(stream.push("MEDIA:/tmp/a.png"), "MEDIA:/tmp/a.png");
  });
});
