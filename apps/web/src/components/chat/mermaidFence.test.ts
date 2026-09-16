import { describe, expect, it } from "vite-plus/test";

import { canToggleMermaidFenceView, mermaidFenceView } from "./mermaidFence";

const baseState = {
  code: "graph LR\n  A --> B",
  isStreaming: false,
  sourceRequested: false,
  failedCode: null,
} as const;

describe("mermaidFenceView", () => {
  it("shows the diagram for a settled fence nobody has touched", () => {
    expect(mermaidFenceView(baseState)).toBe("diagram");
  });

  it("shows source while the message is still streaming", () => {
    expect(mermaidFenceView({ ...baseState, isStreaming: true })).toBe("source");
  });

  it("shows source once the reader asks for it", () => {
    expect(mermaidFenceView({ ...baseState, sourceRequested: true })).toBe("source");
  });

  it("shows source for text mermaid has already rejected", () => {
    expect(mermaidFenceView({ ...baseState, failedCode: baseState.code })).toBe("source");
  });

  it("retries once the fence text changes", () => {
    // The edit that fixes the syntax must not stay stuck on the failed view.
    expect(mermaidFenceView({ ...baseState, failedCode: "graph LR\n  A -->" })).toBe("diagram");
  });
});

describe("canToggleMermaidFenceView", () => {
  it("offers the toggle for a settled fence", () => {
    expect(canToggleMermaidFenceView(baseState)).toBe(true);
  });

  it("hides the toggle while streaming, when source is the only option", () => {
    expect(canToggleMermaidFenceView({ ...baseState, isStreaming: true })).toBe(false);
  });

  it("hides the toggle for a fence that failed to render", () => {
    expect(canToggleMermaidFenceView({ ...baseState, failedCode: baseState.code })).toBe(false);
  });

  it("offers the toggle again once the failed text is edited", () => {
    expect(canToggleMermaidFenceView({ ...baseState, failedCode: "stale" })).toBe(true);
  });
});
