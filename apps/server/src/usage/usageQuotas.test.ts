import { describe, expect, it } from "vite-plus/test";

import {
  parseClaudeQuotaOutput,
  parseClaudeUsageCommandOutput,
  parseCodexRateLimitsLine,
} from "./usageQuotas.ts";

describe("usage quota parsers", () => {
  it("parses Claude session and weekly windows", () => {
    const quotas = parseClaudeQuotaOutput(
      [
        "Current session: 0% used",
        "Current week (all models): 22% used · resets Sep 4 at 1:59pm (America/Chicago)",
        "Last 24h · 1142 requests · 10 sessions",
      ].join("\n"),
    );

    expect(quotas).toHaveLength(2);
    expect(quotas[0]).toMatchObject({ window: "session", remainingPercentage: 100 });
    expect(quotas[1]).toMatchObject({
      provider: "claude",
      window: "week (all models)",
      remainingPercentage: 78,
      resetDate: "Sep 4 at 1:59pm (America/Chicago)",
      status: "available",
    });
  });

  it("unwraps Claude's JSON usage response", () => {
    const quotas = parseClaudeUsageCommandOutput(
      JSON.stringify({ result: "Current week (all models): 22% used" }),
    );
    expect(quotas[0]?.remainingPercentage).toBe(78);
  });

  it("parses Codex primary and secondary rate limits", () => {
    const quotas = parseCodexRateLimitsLine(
      JSON.stringify({
        rate_limits: {
          primary: { used_percent: 7, window_minutes: 300, resets_at: 1787691333 },
          secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1788278133 },
        },
      }),
    );

    expect(quotas).toHaveLength(2);
    expect(quotas[0]).toMatchObject({
      provider: "codex",
      window: "Current session",
      remainingPercentage: 93,
      unit: "percent",
      status: "available",
    });
  });
});
