/**
 * Locating a sub-thread's source quote inside its parent message.
 *
 * The quote was captured from a DOM selection over the rendered message, so
 * matching runs against rendered text content, whitespace-normalized on both
 * sides (rendering collapses whitespace differently than the clipboard does).
 * A quote only gets an inline highlight when it matches exactly once —
 * anything else (message edited, truncated quote now ambiguous) degrades to
 * the message-level chip row, which always renders.
 *
 * The inline decoration itself uses the CSS Custom Highlight API (see
 * useSubThreadQuoteHighlights), so finding a match never mutates the DOM and
 * never re-renders the transcript.
 */

export interface QuoteAnchorRange {
  /** Offsets into the original (un-normalized) rendered text. */
  readonly start: number;
  readonly end: number;
}

interface NormalizedText {
  readonly text: string;
  /** For each normalized character, its offset in the original string. */
  readonly sourceOffsets: ReadonlyArray<number>;
}

function normalizeWithOffsets(input: string): NormalizedText {
  let text = "";
  const sourceOffsets: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (/\s/.test(char)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      // A collapsed space points at the first following character so a match
      // boundary can never land inside the removed run.
      sourceOffsets.push(index);
      pendingSpace = false;
    }
    text += char;
    sourceOffsets.push(index);
  }
  return { text, sourceOffsets };
}

function normalizeQuote(quoteText: string): string {
  // The stored quote may end with the truncation ellipsis; matching uses the
  // verbatim prefix.
  return quoteText.trim().replace(/…$/, "").trim().replace(/\s+/g, " ");
}

/**
 * Find the quote in the rendered text of its message. Returns the range in
 * original text offsets when the match is unique, null otherwise.
 */
export function findQuoteAnchor(renderedText: string, quoteText: string): QuoteAnchorRange | null {
  const needle = normalizeQuote(quoteText);
  if (needle.length === 0) {
    return null;
  }
  const haystack = normalizeWithOffsets(renderedText);
  const first = haystack.text.indexOf(needle);
  if (first < 0) {
    return null;
  }
  if (haystack.text.indexOf(needle, first + 1) >= 0) {
    return null;
  }
  const startOffset = haystack.sourceOffsets[first];
  const lastOffset = haystack.sourceOffsets[first + needle.length - 1];
  if (startOffset === undefined || lastOffset === undefined) {
    return null;
  }
  return { start: startOffset, end: lastOffset + 1 };
}
