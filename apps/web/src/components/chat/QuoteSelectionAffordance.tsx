/**
 * "Ask about this" — the way into a sub-thread. Watches the selection inside
 * the transcript container and floats a single action over selections that
 * live entirely inside one assistant message. Selection tracking is
 * rAF-coalesced and renders nothing at all while there is no eligible
 * selection; scrolling dismisses the affordance rather than tracking it.
 */
import { MessageSquareQuote } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface EligibleSelection {
  readonly messageId: string;
  readonly quoteText: string;
  /** Viewport coordinates of the selection's bounding rect. */
  readonly rect: { top: number; left: number; width: number };
}

interface QuoteSelectionAffordanceProps {
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onAskAboutSelection: (input: { messageId: string; quoteText: string }) => void;
}

function resolveEligibleSelection(container: HTMLElement): EligibleSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const quoteText = selection.toString().trim();
  if (quoteText.length === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const commonAncestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const messageElement = commonAncestor?.closest<HTMLElement>(
    '[data-message-id][data-message-role="assistant"]',
  );
  if (!messageElement || !container.contains(messageElement)) {
    return null;
  }
  const messageId = messageElement.dataset["messageId"];
  if (!messageId) {
    return null;
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  return {
    messageId,
    quoteText,
    rect: { top: rect.top, left: rect.left, width: rect.width },
  };
}

export function QuoteSelectionAffordance(props: QuoteSelectionAffordanceProps) {
  const { containerRef, enabled, onAskAboutSelection } = props;
  const [selection, setSelection] = useState<EligibleSelection | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }
    const onSelectionChange = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const container = containerRef.current;
        setSelection(container ? resolveEligibleSelection(container) : null);
      });
    };
    // Scroll moves the selection's viewport rect out from under the button;
    // dismiss instead of tracking every frame.
    const onScroll = () => setSelection((current) => (current === null ? current : null));
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, { capture: true });
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [containerRef, enabled]);

  const onAsk = useCallback(() => {
    if (!selection) return;
    onAskAboutSelection({ messageId: selection.messageId, quoteText: selection.quoteText });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, [onAskAboutSelection, selection]);

  if (!selection) {
    return null;
  }

  return (
    <div
      className="fixed z-50"
      style={{
        top: Math.max(selection.rect.top - 34, 8),
        left: selection.rect.left + selection.rect.width / 2,
        transform: "translateX(-50%)",
      }}
    >
      <button
        type="button"
        // Fires before the click clears the selection.
        onPointerDown={(event) => {
          event.preventDefault();
          onAsk();
        }}
        className="flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs shadow-md transition-colors hover:bg-muted"
      >
        <MessageSquareQuote className="size-3" />
        Ask about this
      </button>
    </div>
  );
}
