import type { UsageProviderQuota } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  quotaPriority,
  quotaWindowLabel,
  selectQuotaPerProvider,
} from "./usageQuotaPresentation.ts";

function quota(overrides: Partial<UsageProviderQuota>): UsageProviderQuota {
  return {
    provider: "claude",
    window: "session",
    remainingPercentage: 50,
    usedAmount: null,
    limitAmount: null,
    unit: "percent",
    isUnlimited: false,
    resetDate: null,
    status: "available",
    message: null,
    ...overrides,
  } as UsageProviderQuota;
}

/** The three windows `claude -p /usage` reports on a subscription account. */
const CLAUDE_WINDOWS = [
  quota({ window: "session", remainingPercentage: 22 }),
  quota({ window: "week (all models)", remainingPercentage: 69 }),
  quota({ window: "week (Fable)", remainingPercentage: 96 }),
];

it("shows the window closest to its limit", () => {
  const [selected] = selectQuotaPerProvider([CLAUDE_WINDOWS]);
  expect(selected?.window).toBe("session");
});

it("switches to the weekly cap once it is the tighter one", () => {
  const heavyWeek = [
    quota({ window: "session", remainingPercentage: 88 }),
    quota({ window: "week (all models)", remainingPercentage: 9 }),
  ];
  const [selected] = selectQuotaPerProvider([heavyWeek]);
  expect(selected?.window).toBe("week (all models)");
});

it("prefers any real number over an unlimited or unavailable window", () => {
  const mixed = [
    quota({ window: "Account quota", status: "unavailable", remainingPercentage: null }),
    quota({ window: "Premium interactions", isUnlimited: true, remainingPercentage: 0 }),
    quota({ window: "session", remainingPercentage: 3 }),
  ];
  const [selected] = selectQuotaPerProvider([mixed]);
  expect(selected?.window).toBe("session");
  expect(quotaPriority(mixed[0]!)).toBeGreaterThan(quotaPriority(mixed[1]!));
});

it("keeps one window per provider, in a stable order", () => {
  const selected = selectQuotaPerProvider([
    [quota({ provider: "copilot", window: "Premium interactions", remainingPercentage: 40 })],
    CLAUDE_WINDOWS,
    [quota({ provider: "codex", window: "Current session", remainingPercentage: 10 })],
  ]);
  expect(selected.map((entry) => entry.provider)).toEqual(["claude", "codex", "copilot"]);
});

it("keeps the model family when relabelling a weekly window", () => {
  // Both weekly caps would otherwise read "Weekly quota", which is the same
  // label for two different limits now that either can reach the tile.
  expect(quotaWindowLabel(quota({ window: "week (all models)" }))).toBe(
    "Weekly quota (all models)",
  );
  expect(quotaWindowLabel(quota({ window: "week (Fable)" }))).toBe("Weekly quota (Fable)");
  expect(quotaWindowLabel(quota({ window: "week" }))).toBe("Weekly quota");
  expect(quotaWindowLabel(quota({ window: "session" }))).toBe("Current session");
});

it("leaves an unavailable placeholder window unlabelled", () => {
  expect(quotaWindowLabel(quota({ window: "Account quota", status: "unavailable" }))).toBe(
    "Account quota",
  );
});
