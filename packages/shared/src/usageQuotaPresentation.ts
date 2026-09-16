/**
 * Which quota window a surface shows, and what it calls it.
 *
 * A provider reports several windows at once — Claude a session and one weekly
 * cap per model family, Codex a primary and a secondary. The page shows one
 * tile per provider, so something has to choose. Shared because web and mobile
 * render the same tile and had drifted apart while each kept its own copy.
 *
 * @module usageQuotaPresentation
 */
import type { UsageProviderQuota } from "@t3tools/contracts";

/** Tile order, so a provider does not move as its numbers change. */
export const QUOTA_PROVIDER_ORDER = ["claude", "codex", "copilot"] as const;

/** Ranks below any real percentage, so a usable number always wins the tile. */
const UNLIMITED_PRIORITY = 200;
const UNAVAILABLE_PRIORITY = 300;

/**
 * Lower wins. Ranking by what is left shows whichever window is closest to
 * biting: a weekly cap on a heavy week, the session on a heavy day. Unlimited
 * and unavailable windows sort last so they only surface when nothing else can.
 */
export function quotaPriority(quota: UsageProviderQuota): number {
  if (quota.status === "unavailable") return UNAVAILABLE_PRIORITY;
  if (quota.isUnlimited || quota.remainingPercentage === null) return UNLIMITED_PRIORITY;
  return quota.remainingPercentage;
}

/**
 * The most-consumed window per provider, in `QUOTA_PROVIDER_ORDER`. Providers
 * that reported nothing are omitted rather than rendered empty.
 */
export function selectQuotaPerProvider(
  summaries: ReadonlyArray<ReadonlyArray<UsageProviderQuota> | undefined>,
): ReadonlyArray<UsageProviderQuota> {
  const selected = new Map<UsageProviderQuota["provider"], UsageProviderQuota>();
  for (const quotas of summaries) {
    for (const quota of quotas ?? []) {
      const current = selected.get(quota.provider);
      if (!current || quotaPriority(quota) < quotaPriority(current)) {
        selected.set(quota.provider, quota);
      }
    }
  }
  return QUOTA_PROVIDER_ORDER.flatMap((provider) => {
    const quota = selected.get(provider);
    return quota ? [quota] : [];
  });
}

export function quotaProviderLabel(provider: UsageProviderQuota["provider"]): string {
  return provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : "GitHub Copilot";
}

const CLAUDE_WEEK_QUALIFIER = /^week \((.+)\)$/i;

/**
 * Claude names its windows `session` and `week (<model family>)`. The qualifier
 * has to survive the relabel now that a weekly window can reach the tile —
 * without it, two different caps both read "Weekly quota".
 */
export function quotaWindowLabel(quota: UsageProviderQuota): string {
  // An unavailable quota carries a placeholder window, not one the provider
  // named, so it must not be relabelled as a window we never read.
  if (quota.status === "unavailable" || quota.provider !== "claude") {
    return quota.window;
  }
  if (quota.window.toLowerCase() === "session") {
    return "Current session";
  }
  const qualifier = CLAUDE_WEEK_QUALIFIER.exec(quota.window)?.[1];
  return qualifier ? `Weekly quota (${qualifier})` : "Weekly quota";
}

/** ISO resets are formatted by the caller's locale helper; anything else is already prose. */
export function isIsoResetDate(resetDate: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(resetDate);
}
