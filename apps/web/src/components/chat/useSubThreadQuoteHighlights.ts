/**
 * Inline decoration for sub-thread quotes via the CSS Custom Highlight API:
 * no DOM mutation, no re-renders, and a no-op on browsers without support.
 * Styling lives in `::highlight(sub-thread-quote)`.
 *
 * This is decoration only — a quote that fails to match (edited message,
 * ambiguous text) simply gets no highlight; the chip row under the message is
 * the guaranteed affordance. Ranges break when the virtualized list swaps DOM
 * nodes, so a mutation observer reapplies them, coalesced to one pass per
 * frame.
 */
import type { SubThreadAnchor } from "@t3tools/client-runtime/state/subThreads";
import { useEffect, type RefObject } from "react";

import { findQuoteAnchor } from "~/subThreadAnchors";

export const SUB_THREAD_QUOTE_HIGHLIGHT_NAME = "sub-thread-quote";

function rangeFromTextOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let startSet = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!startSet && start < offset + length) {
      range.setStart(node, start - offset);
      startSet = true;
    }
    if (startSet && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

export function useSubThreadQuoteHighlights(
  containerRef: RefObject<HTMLElement | null>,
  anchors: ReadonlyArray<SubThreadAnchor> | null,
): void {
  useEffect(() => {
    const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!highlights) {
      return;
    }
    if (!anchors || anchors.length === 0) {
      highlights.delete(SUB_THREAD_QUOTE_HIGHLIGHT_NAME);
      return;
    }

    let frame: number | null = null;
    const apply = () => {
      frame = null;
      const container = containerRef.current;
      if (!container) return;
      const ranges: Range[] = [];
      for (const anchor of anchors) {
        const messageElement = container.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
        );
        if (!messageElement) continue;
        const match = findQuoteAnchor(messageElement.textContent ?? "", anchor.quoteText);
        if (!match) continue;
        const range = rangeFromTextOffsets(messageElement, match.start, match.end);
        if (range) ranges.push(range);
      }
      if (ranges.length > 0) {
        highlights.set(SUB_THREAD_QUOTE_HIGHLIGHT_NAME, new Highlight(...ranges));
      } else {
        highlights.delete(SUB_THREAD_QUOTE_HIGHLIGHT_NAME);
      }
    };
    const scheduleApply = () => {
      if (frame === null) {
        frame = requestAnimationFrame(apply);
      }
    };

    scheduleApply();
    const observer = new MutationObserver(scheduleApply);
    if (containerRef.current) {
      observer.observe(containerRef.current, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      highlights.delete(SUB_THREAD_QUOTE_HIGHLIGHT_NAME);
    };
  }, [anchors, containerRef]);
}
