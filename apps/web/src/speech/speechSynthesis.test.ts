import { describe, expect, it } from "vite-plus/test";

import { sortVoicesForLocale, splitUtteranceChunks } from "./speechSynthesis";

describe("splitUtteranceChunks", () => {
  it("packs whole sentences up to the limit", () => {
    const chunks = splitUtteranceChunks("One two. Three four! Five six? Seven.", 20);
    expect(chunks).toEqual(["One two. Three four!", "Five six? Seven."]);
  });

  it("splits an oversized sentence at a clause or word boundary", () => {
    const chunks = splitUtteranceChunks(
      "This clause is long, and this one is longer still, and it keeps going",
      30,
    );
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
    expect(chunks.join(" ")).toBe(
      "This clause is long, and this one is longer still, and it keeps going",
    );
  });

  it("returns nothing for blank text", () => {
    expect(splitUtteranceChunks("   ")).toEqual([]);
  });
});

describe("sortVoicesForLocale", () => {
  const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;

  it("puts the locale's voices first and sorts each group by name", () => {
    const sorted = sortVoicesForLocale(
      [voice("Zoe", "fr-FR"), voice("Samantha", "en-US"), voice("Daniel", "en-GB")],
      "en-US",
    );
    expect(sorted.map((entry) => entry.name)).toEqual(["Daniel", "Samantha", "Zoe"]);
  });
});
