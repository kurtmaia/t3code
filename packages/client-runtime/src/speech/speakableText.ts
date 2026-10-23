/**
 * Turns an agent's markdown reply into text a speech synthesizer can read.
 * Code, tables, and diagrams are replaced with short placeholders, links keep
 * their label, paths keep their basename, and the result is capped at a
 * sentence boundary so a long reply never becomes a monologue.
 */

export const SPEAKABLE_TEXT_MAX_CHARS = 900;
export const SPEAKABLE_TEXT_TRUNCATION_NOTICE = "There's more in the thread.";

export interface SpeakableText {
  readonly text: string;
  readonly truncated: boolean;
}

const CODE_PLACEHOLDER = "Code omitted.";
const DIAGRAM_PLACEHOLDER = "Diagram omitted.";
const TABLE_PLACEHOLDER = "Table omitted.";

const FENCE_PATTERN = /^(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*\n[\s\S]*?(?:^\1[ \t]*$|(?![\s\S]))/gm;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>\n]*>/g;
const IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const REFERENCE_LINK_PATTERN = /\[([^\]]+)\]\[[^\]]*\]/g;
const AUTOLINK_PATTERN = /<(?:https?:\/\/|mailto:)[^>]*>/g;
const BARE_URL_PATTERN = /\bhttps?:\/\/[^\s)]+/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const HEADING_PATTERN = /^#{1,6}[ \t]+/;
const BLOCKQUOTE_PATTERN = /^(?:>[ \t]?)+/;
const LIST_MARKER_PATTERN = /^(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const HORIZONTAL_RULE_PATTERN = /^(?:[-*_][ \t]*){3,}$/;
const EMPHASIS_PATTERN = /(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g;
const SINGLE_EMPHASIS_PATTERN = /(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?=[^\w*]|$)/g;
const TABLE_ROW_PATTERN = /^\|.*\|[ \t]*$/;
const TERMINAL_PUNCTUATION_PATTERN = /[.!?:;,]$/;

function spokenInlineCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.includes("/")) {
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
    return segments.at(-1) ?? "";
  }
  return trimmed;
}

function ensureTerminalPunctuation(line: string): string {
  return TERMINAL_PUNCTUATION_PATTERN.test(line) ? line : `${line}.`;
}

function collapseBlocks(blocks: ReadonlyArray<string>): string[] {
  const collapsed: string[] = [];
  for (const block of blocks) {
    if (block.length === 0) continue;
    const previous = collapsed.at(-1);
    const isPlaceholder =
      block === CODE_PLACEHOLDER || block === DIAGRAM_PLACEHOLDER || block === TABLE_PLACEHOLDER;
    if (isPlaceholder && previous === block) continue;
    collapsed.push(block);
  }
  return collapsed;
}

function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (sentenceEnd >= Math.floor(maxChars / 3)) {
    return window.slice(0, sentenceEnd + 1);
  }
  const wordEnd = window.lastIndexOf(" ");
  const cut = wordEnd > 0 ? window.slice(0, wordEnd) : window;
  return ensureTerminalPunctuation(cut.replace(/[,;:\s]+$/, ""));
}

export function toSpeakableText(
  markdown: string,
  options?: { readonly maxChars?: number },
): SpeakableText {
  const maxChars = options?.maxChars ?? SPEAKABLE_TEXT_MAX_CHARS;
  const withoutFences = markdown
    .replace(/\r\n?/g, "\n")
    .replace(
      FENCE_PATTERN,
      (_match, _fence: string, language: string) =>
        `\n\n${language.toLowerCase() === "mermaid" ? DIAGRAM_PLACEHOLDER : CODE_PLACEHOLDER}\n\n`,
    )
    .replace(HTML_COMMENT_PATTERN, " ")
    .replace(HTML_TAG_PATTERN, " ")
    .replace(IMAGE_PATTERN, " ")
    .replace(AUTOLINK_PATTERN, "a link")
    .replace(LINK_PATTERN, "$1")
    .replace(REFERENCE_LINK_PATTERN, "$1")
    .replace(BARE_URL_PATTERN, "a link")
    .replace(INLINE_CODE_PATTERN, (_match, code: string) => spokenInlineCode(code));

  const blocks: string[] = [];
  let paragraph: string[] = [];
  let inTable = false;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(ensureTerminalPunctuation(paragraph.join(" ")));
      paragraph = [];
    }
  };

  for (const rawLine of withoutFences.split("\n")) {
    const line = rawLine.trim().replace(BLOCKQUOTE_PATTERN, "").trim();
    if (line.length === 0) {
      flushParagraph();
      inTable = false;
      continue;
    }
    if (TABLE_ROW_PATTERN.test(line)) {
      flushParagraph();
      if (!inTable) {
        blocks.push(TABLE_PLACEHOLDER);
        inTable = true;
      }
      continue;
    }
    inTable = false;
    if (HORIZONTAL_RULE_PATTERN.test(line)) {
      flushParagraph();
      continue;
    }
    const heading = HEADING_PATTERN.test(line);
    const listItem = LIST_MARKER_PATTERN.test(line);
    const content = line
      .replace(HEADING_PATTERN, "")
      .replace(LIST_MARKER_PATTERN, "")
      .replace(EMPHASIS_PATTERN, "$2")
      .replace(SINGLE_EMPHASIS_PATTERN, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
    if (content.length === 0) continue;
    if (heading || listItem) {
      flushParagraph();
      blocks.push(ensureTerminalPunctuation(content));
      continue;
    }
    paragraph.push(content);
  }
  flushParagraph();

  const text = collapseBlocks(blocks).join(" ");
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const head = truncateAtSentence(text, maxChars);
  return {
    text:
      head.length > 0
        ? `${head} ${SPEAKABLE_TEXT_TRUNCATION_NOTICE}`
        : SPEAKABLE_TEXT_TRUNCATION_NOTICE,
    truncated: true,
  };
}
