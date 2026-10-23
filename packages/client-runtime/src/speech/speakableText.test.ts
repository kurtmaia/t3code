import { describe, expect, it } from "vite-plus/test";

import { SPEAKABLE_TEXT_TRUNCATION_NOTICE, toSpeakableText } from "./speakableText.ts";

describe("toSpeakableText", () => {
  it("replaces fenced code and diagrams with placeholders and collapses repeats", () => {
    const markdown = [
      "Here is the fix.",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "```bash",
      "echo hi",
      "```",
      "",
      "```mermaid",
      "graph TD; A-->B;",
      "```",
      "",
      "Done.",
    ].join("\n");
    expect(toSpeakableText(markdown).text).toBe(
      "Here is the fix. Code omitted. Diagram omitted. Done.",
    );
  });

  it("keeps link labels, drops images, and names bare urls", () => {
    const markdown =
      "See [the docs](https://example.com/docs) and https://example.com/raw ![shot](a.png) now.";
    expect(toSpeakableText(markdown).text).toBe("See the docs and a link now.");
  });

  it("reads inline code and shortens paths to their basename", () => {
    const markdown = "Edit `apps/web/src/components/ChatView.tsx` and call `useThread`.";
    expect(toSpeakableText(markdown).text).toBe("Edit ChatView.tsx and call useThread.");
  });

  it("flattens headings, lists, quotes, and emphasis into sentences", () => {
    const markdown = [
      "## Summary",
      "",
      "- **First** item",
      "- Second item.",
      "1. Third _item_",
      "",
      "> Quoted thought",
      "",
      "---",
      "",
      "Plain *text* ~~gone~~ here",
    ].join("\n");
    expect(toSpeakableText(markdown).text).toBe(
      "Summary. First item. Second item. Third item. Quoted thought. Plain text gone here.",
    );
  });

  it("replaces tables with one placeholder per table", () => {
    const markdown = [
      "Results:",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "That is all.",
    ].join("\n");
    expect(toSpeakableText(markdown).text).toBe("Results: Table omitted. That is all.");
  });

  it("strips html tags and comments", () => {
    expect(toSpeakableText("<!-- hidden -->Hello <br/> <b>world</b>").text).toBe("Hello world.");
  });

  it("caps long replies at a sentence boundary and says there is more", () => {
    const sentence = "This sentence is exactly long enough to matter. ";
    const result = toSpeakableText(sentence.repeat(40), { maxChars: 120 });
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(SPEAKABLE_TEXT_TRUNCATION_NOTICE)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(
      120 + SPEAKABLE_TEXT_TRUNCATION_NOTICE.length + 1,
    );
    expect(result.text).toMatch(/matter\. There's more in the thread\.$/);
  });

  it("falls back to a word boundary when no sentence fits", () => {
    const result = toSpeakableText("word ".repeat(100), { maxChars: 40 });
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/^(word ){1,8}word\. There's more in the thread\.$/);
  });

  it("returns empty text for whitespace-only input", () => {
    expect(toSpeakableText("  \n\n ")).toEqual({ text: "", truncated: false });
  });
});
