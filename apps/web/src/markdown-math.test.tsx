import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_MARKDOWN_MATH_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "./components/ChatMarkdown";

/** Renders through the real pipeline, so plugin order is part of what is tested. */
function renderMarkdown(markdown: string, { parseRawHtml = false } = {}): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={
        parseRawHtml ? CHAT_MARKDOWN_REHYPE_PLUGINS : CHAT_MARKDOWN_MATH_REHYPE_PLUGINS
      }
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("markdown math", () => {
  it("renders a display equation instead of printing its source", () => {
    const html = renderMarkdown("$$Y_i \\mid x_i \\sim \\mathcal{N}(\\mu, \\sigma^2)$$");

    // KaTeX keeps the TeX source in a MathML <annotation> on purpose, for copy
    // and for screen readers, so the claim is that the delimiters were consumed
    // and typeset output exists — not that the source is absent.
    expect(html).toContain('class="katex"');
    expect(html).toContain("<math");
    expect(html).not.toContain("$$");
  });

  it("renders inline math inside a sentence", () => {
    const html = renderMarkdown("weights $w_i = \\exp(\\lambda t_i)$ decay with age");

    expect(html).toContain("katex");
    expect(html).toContain("decay with age");
  });

  it("still renders math when raw HTML is parsed, where the sanitizer also runs", () => {
    // rehype-katex has to run after rehype-sanitize; reversed, the sanitizer
    // strips KaTeX's generated markup and the equation renders as bare text.
    const html = renderMarkdown("$$a^2 + b^2 = c^2$$", { parseRawHtml: true });

    expect(html).toContain("katex");
  });

  it("renders a half-written expression rather than throwing", () => {
    // Every streaming message passes through this state on its way to valid.
    expect(() => renderMarkdown("$$\\frac{1}{$$")).not.toThrow();
  });

  it("leaves a bare dollar amount alone", () => {
    const html = renderMarkdown("it costs $5 and change");

    expect(html).toContain("it costs $5 and change");
    expect(html).not.toContain("katex");
  });

  it("leaves two dollar amounts in a sentence alone", () => {
    // The closing candidate sits after a space, which no inline expression does.
    const html = renderMarkdown("both $3,230 linehaul + $1,566.55 fuel");

    expect(html).toContain("both $3,230 linehaul + $1,566.55 fuel");
    expect(html).not.toContain("katex");
  });

  it("keeps emphasis around a dollar amount instead of typesetting it", () => {
    // The regression this guards: the math span used to swallow the `**`, so
    // the amount lost its bold as well as its dollar sign.
    const html = renderMarkdown("fuel + $270 tankwash = **$2,973.01**");

    expect(html).toContain("<strong>$2,973.01</strong>");
    expect(html).not.toContain("katex");
  });

  it("leaves a rate written as a ratio of amounts alone", () => {
    const html = renderMarkdown("linehaul $1,738.05/$525.2 mi");

    expect(html).toContain("linehaul $1,738.05/$525.2 mi");
    expect(html).not.toContain("katex");
  });

  it("still renders inline math on a line that also quotes an amount", () => {
    const html = renderMarkdown("it costs $5, and $x^2$ holds");

    expect(html).toContain("katex");
    expect(html).toContain("it costs $5,");
  });

  it("keeps display math permissive about padding", () => {
    const html = renderMarkdown("$$ a^2 + b^2 = c^2 $$");

    expect(html).toContain("katex");
  });
});
