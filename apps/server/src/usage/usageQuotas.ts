import type { UsageProviderQuota } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const clampPercentage = (value: number): number => Math.max(0, Math.min(100, value));

function quotaWindow(
  provider: UsageProviderQuota["provider"],
  window: string,
  usedPercentage: number,
  resetDate: string | null,
): UsageProviderQuota {
  return {
    provider,
    window,
    remainingPercentage: clampPercentage(100 - usedPercentage),
    usedAmount: null,
    limitAmount: null,
    unit: "percent",
    isUnlimited: false,
    resetDate,
    status: "available",
    message: null,
  };
}

/** Parses the human-readable quota section returned by `claude -p /usage`. */
export function parseClaudeQuotaOutput(output: string): readonly UsageProviderQuota[] {
  const quotas: UsageProviderQuota[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^Current (session|week(?: \([^)]*\))?):\s*([\d.]+)% used(?: · resets (.+))?$/i.exec(
        line.trim(),
      );
    if (!match) continue;
    const usedPercentage = Number(match[2]);
    const window = match[1];
    if (!Number.isFinite(usedPercentage) || !window) continue;
    quotas.push(quotaWindow("claude", window, usedPercentage, match[3] ?? null));
  }
  return quotas;
}

/** Parses Claude's JSON envelope while tolerating plain-text CLI output. */
export function parseClaudeUsageCommandOutput(output: string): readonly UsageProviderQuota[] {
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { result?: unknown }).result === "string"
    ) {
      return parseClaudeQuotaOutput((parsed as { result: string }).result);
    }
  } catch {
    // Older Claude CLIs may return the result without the JSON envelope.
  }
  return parseClaudeQuotaOutput(output);
}

function resetDateFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return DateTime.formatIso(DateTime.makeUnsafe(value * 1000));
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extracts Codex's latest primary/secondary account rate-limit windows. */
export function parseCodexRateLimitsLine(line: string): readonly UsageProviderQuota[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const payload = record.payload;
  const payloadRecord =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const rateLimits = record.rate_limits ?? payloadRecord?.rate_limits;
  if (!rateLimits || typeof rateLimits !== "object") return [];

  const result: UsageProviderQuota[] = [];
  for (const [key, label] of [
    ["primary", "Primary window"],
    ["secondary", "Secondary window"],
  ] as const) {
    const window = (rateLimits as Record<string, unknown>)[key];
    if (!window || typeof window !== "object") continue;
    const windowRecord = window as Record<string, unknown>;
    const usedPercentage = numberValue(windowRecord.used_percent);
    if (usedPercentage === null) continue;
    const windowMinutes = numberValue(windowRecord.window_minutes);
    result.push(
      quotaWindow(
        "codex",
        windowMinutes !== null && windowMinutes <= 300 ? "Current session" : label,
        usedPercentage,
        resetDateFromUnixSeconds(windowRecord.resets_at),
      ),
    );
  }
  return result;
}

export function unavailableQuota(
  provider: UsageProviderQuota["provider"],
  message: string,
): UsageProviderQuota {
  return {
    provider,
    window: "Account quota",
    remainingPercentage: null,
    usedAmount: null,
    limitAmount: null,
    unit: "percent",
    isUnlimited: false,
    resetDate: null,
    status: "unavailable",
    message,
  };
}

export function copilotQuotaWindow(input: {
  readonly window: string;
  readonly remainingPercentage: number;
  readonly usedAmount: number | null;
  readonly limitAmount: number | null;
  readonly unit: "requests" | "credits";
  readonly resetDate: string | null;
  readonly isUnlimited?: boolean;
}): UsageProviderQuota {
  return {
    provider: "copilot",
    window: input.window,
    remainingPercentage: clampPercentage(input.remainingPercentage),
    usedAmount: input.usedAmount,
    limitAmount: input.limitAmount,
    unit: input.unit,
    isUnlimited: input.isUnlimited ?? false,
    resetDate: input.resetDate,
    status: "available",
    message: null,
  };
}
