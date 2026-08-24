/**
 * Keys a touch keyboard does not have.
 *
 * A phone keyboard offers no Esc, Tab, Ctrl or arrows, which makes a terminal
 * close to unusable: no completion, no history, no way out of vim, no way to
 * interrupt a runaway command. This is the same bar every mobile SSH client
 * ships, for the same reason.
 *
 * Fixed combinations rather than a sticky Ctrl modifier: the soft keyboard's
 * keystrokes go straight to the terminal's hidden textarea, so a modifier
 * armed here could never intercept the letter that follows it.
 */
export interface TerminalKeyBarKey {
  readonly id: string;
  /** Shown on the button. Short: the bar has to fit a phone. */
  readonly label: string;
  /** Spoken name, since several labels are bare symbols. */
  readonly ariaLabel: string;
  /** Bytes written to the pty. */
  readonly data: string;
}

const ESC = "\u001b";

/** Control characters are the letter's code minus 64: ^C is 0x03. */
const control = (letter: string): string =>
  String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);

/**
 * Arrows use the normal-mode CSI forms. A terminal in application cursor mode
 * sends SS3 (ESC O A) instead, but that mode is not exposed on the surface
 * snapshot, and the readline and full-screen programs that matter accept the
 * CSI forms either way.
 */
export const TERMINAL_KEY_BAR_KEYS: ReadonlyArray<TerminalKeyBarKey> = [
  { id: "esc", label: "Esc", ariaLabel: "Escape", data: ESC },
  { id: "tab", label: "Tab", ariaLabel: "Tab", data: "\t" },
  { id: "ctrl-c", label: "^C", ariaLabel: "Control C, interrupt", data: control("c") },
  { id: "ctrl-d", label: "^D", ariaLabel: "Control D, end of input", data: control("d") },
  { id: "ctrl-z", label: "^Z", ariaLabel: "Control Z, suspend", data: control("z") },
  { id: "ctrl-r", label: "^R", ariaLabel: "Control R, search history", data: control("r") },
  { id: "ctrl-l", label: "^L", ariaLabel: "Control L, clear screen", data: control("l") },
  { id: "up", label: "\u2191", ariaLabel: "Up arrow", data: `${ESC}[A` },
  { id: "down", label: "\u2193", ariaLabel: "Down arrow", data: `${ESC}[B` },
  { id: "left", label: "\u2190", ariaLabel: "Left arrow", data: `${ESC}[D` },
  { id: "right", label: "\u2192", ariaLabel: "Right arrow", data: `${ESC}[C` },
  { id: "home", label: "Home", ariaLabel: "Home", data: `${ESC}[H` },
  { id: "end", label: "End", ariaLabel: "End", data: `${ESC}[F` },
];

export function terminalKeyBarKey(id: string): TerminalKeyBarKey | null {
  return TERMINAL_KEY_BAR_KEYS.find((key) => key.id === id) ?? null;
}
