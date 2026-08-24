import { describe, expect, it } from "vite-plus/test";

import { TERMINAL_KEY_BAR_KEYS, terminalKeyBarKey } from "./keyBar";

describe("terminal key bar", () => {
  it("sends the control characters a phone keyboard cannot produce", () => {
    // A wrong byte here is worse than a missing key: a ^C that is not 0x03
    // does not interrupt, and on a phone there is no other way to stop a
    // running command.
    expect(terminalKeyBarKey("ctrl-c")?.data).toBe("\u0003");
    expect(terminalKeyBarKey("ctrl-d")?.data).toBe("\u0004");
    expect(terminalKeyBarKey("ctrl-z")?.data).toBe("\u001a");
    expect(terminalKeyBarKey("ctrl-r")?.data).toBe("\u0012");
    expect(terminalKeyBarKey("ctrl-l")?.data).toBe("\u000c");
  });

  it("sends Escape and Tab as single bytes", () => {
    expect(terminalKeyBarKey("esc")?.data).toBe("\u001b");
    expect(terminalKeyBarKey("tab")?.data).toBe("\t");
  });

  it("sends CSI arrows in the conventional directions", () => {
    // A is up and B is down; C is right and D is left. Swapping C and D is the
    // classic mistake, and it reads as the arrows being mirrored.
    expect(terminalKeyBarKey("up")?.data).toBe("\u001b[A");
    expect(terminalKeyBarKey("down")?.data).toBe("\u001b[B");
    expect(terminalKeyBarKey("right")?.data).toBe("\u001b[C");
    expect(terminalKeyBarKey("left")?.data).toBe("\u001b[D");
  });

  it("gives every key a unique id, bytes to send, and a spoken name", () => {
    const ids = TERMINAL_KEY_BAR_KEYS.map((key) => key.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const key of TERMINAL_KEY_BAR_KEYS) {
      expect(key.data.length).toBeGreaterThan(0);
      expect(key.ariaLabel.trim().length).toBeGreaterThan(0);
    }
  });

  it("returns null for an unknown id rather than guessing", () => {
    expect(terminalKeyBarKey("nope")).toBeNull();
  });
});
