import mermaid from "mermaid";
import { useEffect, useId, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Renders one mermaid fence as SVG.
 *
 * Only ever imported through `lazy()`: mermaid is several megabytes, and most
 * threads never contain a diagram, so it must stay out of the main chunk. The
 * caller owns the source/diagram toggle and decides what to show when this
 * reports a failure.
 */
export default function MermaidDiagram({
  code,
  theme,
  onRenderError,
}: {
  readonly code: string;
  readonly theme: "light" | "dark";
  readonly onRenderError: () => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  // mermaid injects this as an element id and queries it back with a CSS
  // selector, so React's colons have to go.
  const reactId = useId();
  const renderId = useMemo(() => `mermaid-${reactId.replace(/[^a-zA-Z0-9-]/g, "-")}`, [reactId]);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "default",
      // Diagram text arrives from an agent or a file in the workspace, so the
      // labels are not ours to trust: strict keeps mermaid from emitting raw
      // HTML or click handlers out of a label.
      securityLevel: "strict",
      fontFamily: "var(--font-sans)",
    });
    mermaid
      .render(renderId, code)
      .then((result) => {
        if (!cancelled) setSvg(result.svg);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Invalid syntax is the common case here, not an exception: agents write
        // diagrams that do not parse. The caller falls back to the source.
        console.warn("[chat-markdown] mermaid render failed", cause);
        onRenderError();
      });
    return () => {
      cancelled = true;
    };
  }, [code, onRenderError, renderId, theme]);

  return (
    <div
      className={cn(
        "chat-markdown-mermaid overflow-x-auto px-3 pt-1 pb-3",
        // The svg carries its own intrinsic size; keep it from overflowing a
        // narrow panel on a phone.
        "[&_svg]:h-auto [&_svg]:max-w-full",
        svg === null && "min-h-24",
      )}
      // Safe by construction: this is mermaid's own SVG output, produced under
      // securityLevel "strict" from the fence text.
      dangerouslySetInnerHTML={svg === null ? undefined : { __html: svg }}
    />
  );
}
