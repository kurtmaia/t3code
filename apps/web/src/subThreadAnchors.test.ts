import { describe, expect, it } from "vite-plus/test";

import { findQuoteAnchor } from "./subThreadAnchors";

const RENDERED = "The projector derives the read model.\nCheckpoints are git refs under the hood.";

describe("findQuoteAnchor", () => {
  it("finds a unique quote at its original offsets", () => {
    const range = findQuoteAnchor(RENDERED, "Checkpoints are git refs");
    expect(range).not.toBeNull();
    expect(RENDERED.slice(range!.start, range!.end)).toBe("Checkpoints are git refs");
  });

  it("matches across whitespace differences on both sides", () => {
    const range = findQuoteAnchor(RENDERED, "read   model.\n Checkpoints");
    expect(range).not.toBeNull();
    expect(RENDERED.slice(range!.start, range!.end)).toBe("read model.\nCheckpoints");
  });

  it("ignores a truncation ellipsis on the stored quote", () => {
    const range = findQuoteAnchor(RENDERED, "git refs under…");
    expect(range).not.toBeNull();
    expect(RENDERED.slice(range!.start, range!.end)).toBe("git refs under");
  });

  it("returns null when the quote no longer appears", () => {
    expect(findQuoteAnchor(RENDERED, "something rewritten away")).toBeNull();
  });

  it("returns null when the quote is ambiguous", () => {
    expect(findQuoteAnchor("twice here and twice here", "twice here")).toBeNull();
  });

  it("returns null for empty quotes", () => {
    expect(findQuoteAnchor(RENDERED, "   ")).toBeNull();
    expect(findQuoteAnchor("", "quote")).toBeNull();
  });
});
