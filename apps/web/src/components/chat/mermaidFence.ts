export type MermaidFenceView = "diagram" | "source";

export interface MermaidFenceState {
  readonly code: string;
  /** The message is still arriving, so the fence text is likely incomplete. */
  readonly isStreaming: boolean;
  /** The reader asked for source with the toggle. */
  readonly sourceRequested: boolean;
  /** Fence text mermaid has already rejected, or null if none has failed. */
  readonly failedCode: string | null;
}

/**
 * Which face of a mermaid fence to show.
 *
 * Source wins while the message streams — a half-written diagram does not parse,
 * and re-rendering one per token would be an expensive way to show an error. It
 * wins again once mermaid has rejected this exact text, so a diagram that never
 * parses degrades to the code block it used to be. Editing the fence is a new
 * diagram and earns a fresh attempt.
 */
export function mermaidFenceView(state: MermaidFenceState): MermaidFenceView {
  if (state.isStreaming) return "source";
  if (state.failedCode === state.code) return "source";
  return state.sourceRequested ? "source" : "diagram";
}

/**
 * Whether the source/diagram toggle does anything. Offering it while the only
 * possible view is source would be a control that visibly does nothing.
 */
export function canToggleMermaidFenceView(state: MermaidFenceState): boolean {
  return !state.isStreaming && state.failedCode !== state.code;
}
