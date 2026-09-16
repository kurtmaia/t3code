import { useCallback, useSyncExternalStore } from "react";

/**
 * How much of the layout viewport the on-screen keyboard is covering.
 *
 * The viewport meta asks for `interactive-widget=resizes-content`, which Chrome
 * on Android honours by shrinking the layout viewport. iOS Safari ignores it:
 * the keyboard is painted over the page and anything anchored to the bottom —
 * a terminal prompt, its key bar — ends up underneath it. The visual viewport
 * is the only place that shift is observable, so read it directly.
 *
 * Returns 0 on desktop, where the visual and layout viewports agree.
 */
export function keyboardInsetFrom(input: {
  readonly innerHeight: number;
  readonly viewportHeight: number;
  readonly offsetTop: number;
}): number {
  const covered = input.innerHeight - (input.viewportHeight + input.offsetTop);
  // Rounding noise and rubber-band scrolling both produce small values that are
  // not a keyboard; treating them as one makes the layout twitch.
  return covered > 1 ? Math.round(covered) : 0;
}

function readKeyboardInset(): number {
  const viewport = globalThis.visualViewport;
  if (viewport === undefined || viewport === null) return 0;
  return keyboardInsetFrom({
    innerHeight: window.innerHeight,
    viewportHeight: viewport.height,
    offsetTop: viewport.offsetTop,
  });
}

function subscribe(onChange: () => void): () => void {
  const viewport = globalThis.visualViewport;
  if (viewport === undefined || viewport === null) return () => {};
  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
  };
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(useCallback(subscribe, []), readKeyboardInset, () => 0);
}
