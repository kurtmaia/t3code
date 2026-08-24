import { TERMINAL_KEY_BAR_KEYS } from "~/terminal/keyBar";

/**
 * Renders the keys a touch keyboard lacks, directly above it.
 *
 * `onMouseDown` with `preventDefault` rather than `onClick`: tapping a button
 * would otherwise blur the terminal's hidden textarea, which dismisses the
 * soft keyboard between every keypress.
 */
export function TerminalKeyBar({ onKey }: { readonly onKey: (data: string) => void }) {
  return (
    <div
      aria-label="Terminal keys"
      className="flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-muted/40 px-2 py-1.5"
      role="toolbar"
    >
      {TERMINAL_KEY_BAR_KEYS.map((key) => (
        <button
          aria-label={key.ariaLabel}
          className="min-w-9 shrink-0 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground active:bg-muted"
          key={key.id}
          onMouseDown={(event) => {
            event.preventDefault();
            onKey(key.data);
          }}
          onTouchStart={(event) => {
            event.preventDefault();
            onKey(key.data);
          }}
          type="button"
        >
          {key.label}
        </button>
      ))}
    </div>
  );
}
