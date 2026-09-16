import { describe, expect, it } from "vite-plus/test";

import { keyboardInsetFrom } from "./useKeyboardInset";

describe("keyboardInsetFrom", () => {
  it("is zero when no keyboard is up", () => {
    expect(keyboardInsetFrom({ innerHeight: 900, viewportHeight: 900, offsetTop: 0 })).toBe(0);
  });

  it("reports the covered height when the keyboard overlays the page", () => {
    // iOS keeps the layout viewport at 900 and shrinks the visual one.
    expect(keyboardInsetFrom({ innerHeight: 900, viewportHeight: 560, offsetTop: 0 })).toBe(340);
  });

  it("accounts for a scrolled visual viewport", () => {
    expect(keyboardInsetFrom({ innerHeight: 900, viewportHeight: 560, offsetTop: 40 })).toBe(300);
  });

  it("ignores sub-pixel noise rather than twitching the layout", () => {
    expect(keyboardInsetFrom({ innerHeight: 900, viewportHeight: 899.4, offsetTop: 0 })).toBe(0);
  });

  it("never returns a negative inset when rubber-band scrolling overshoots", () => {
    expect(keyboardInsetFrom({ innerHeight: 900, viewportHeight: 940, offsetTop: 0 })).toBe(0);
  });
});
