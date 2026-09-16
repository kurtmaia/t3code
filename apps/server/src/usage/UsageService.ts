/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files rather than T3 Code's
 * orchestration projections, so usage covers turns driven outside T3 Code too.
 * This is the approach `ccusage` takes.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";
// Claude's quota lives behind a one-shot `claude -p /usage`, which needs the
// timeout/maxBuffer knobs `execFile` has and Effect's ChildProcess does not
// expose; the call is fully contained in `runClaudeUsageCommand` below.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import {
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsConfig,
  type UsageProviderKind,
  type UsageProviderQuota,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readLatestCodexRateLimits,
  readDirectoryVolumeId,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import {
  copilotQuotaWindow,
  parseClaudeUsageCommandOutput,
  parseCodexRateLimitsLine,
  unavailableQuota,
} from "./usageQuotas.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
  }
>()("t3/usage/UsageService") {}

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: LITELLM_RATES_URL,
          fetchedAt: null,
          knownModels: 0,
        },
        providerQuotas: [],
        scanDurationMs: 0,
      }),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;

  const fileCache: ScanCache = new Map();
  let cacheDirty = false;

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";
  let providerQuotas: readonly UsageProviderQuota[] = [];
  let providerQuotasReadAtMs = 0;

  /**
   * First `copilot` on `PATH`, or `null` when it is not installed — the SDK
   * drives the user's own CLI so it reuses their Copilot login rather than
   * needing the SDK's optional platform package bundled.
   */
  const resolveCopilotExecutable = Effect.fn("UsageService.resolveCopilotExecutable")(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;

    const binary = platform === "win32" ? "copilot.exe" : "copilot";
    for (const directory of (environment.PATH ?? "").split(platform === "win32" ? ";" : ":")) {
      if (!directory) continue;
      const candidate = path.join(directory, binary);
      // Keep looking on a miss; Copilot is an optional provider.
      const found = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (found) return candidate;
    }
    return null;
  });

  const runClaudeUsageCommand = (settings: ServerSettingsConfig) =>
    Effect.gen(function* () {
      const claudeSettings = settings.providers.claudeAgent;
      const platform = yield* HostProcessPlatform;
      const environment = { ...(yield* HostProcessEnvironment) };
      if (claudeSettings.homePath.trim().length > 0) {
        environment.CLAUDE_CONFIG_DIR = path.resolve(expandHomePath(claudeSettings.homePath));
      }
      return yield* Effect.promise(
        () =>
          new Promise<string | null>((resolve) => {
            NodeChildProcess.execFile(
              claudeSettings.binaryPath,
              ["-p", "/usage", "--output-format", "json"],
              {
                env: environment,
                timeout: 15_000,
                maxBuffer: 512 * 1024,
                shell: platform === "win32",
              },
              (error, stdout) => resolve(error ? null : stdout),
            );
          }),
      );
    }).pipe(
      Effect.timeout(16_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const readCopilotQuota = Effect.fn("UsageService.readCopilotQuota")(function* () {
    const copilotExecutable = yield* resolveCopilotExecutable();
    if (copilotExecutable === null) return null;
    const copilotBaseDirectory = path.join(NodeOS.homedir(), ".copilot");
    // Loaded on demand, never at module scope. `ws.ts` imports this service on
    // the server's boot path, and the SDK pulls in a native FFI module (koffi)
    // plus the Copilot CLI itself; a resolution or native-load failure at
    // import time would take the whole backend down in a restart loop, for a
    // provider that is disabled by default. Here it degrades to an unavailable
    // quota, which the tile already knows how to render.
    const sdk = yield* Effect.tryPromise(() => import("@github/copilot-sdk")).pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (sdk === null) return null;
    const { CopilotClient, RuntimeConnection } = sdk;

    const result = yield* Effect.promise(async () => {
      // Use the user's installed CLI so this works on machines where the SDK's
      // optional platform package is not bundled (and reuses Copilot's login).
      const client = new CopilotClient({
        mode: "empty",
        logLevel: "none",
        baseDirectory: copilotBaseDirectory,
        connection: RuntimeConnection.forStdio({ path: copilotExecutable }),
      });
      try {
        await client.start();
        const response = await client.rpc.account.getQuota({});
        const snapshots = response.quotaSnapshots as Record<
          string,
          (typeof response.quotaSnapshots)[string] & { hasQuota?: boolean }
        >;
        const preferredTypes = ["premium_interactions", "chat", "completions"] as const;
        const quotaType =
          preferredTypes.find((type) => snapshots[type]?.hasQuota) ??
          preferredTypes.find((type) => snapshots[type] !== undefined);
        const snapshot = quotaType === undefined ? undefined : snapshots[quotaType];
        if (quotaType === undefined || !snapshot) return null;
        return copilotQuotaWindow({
          window:
            quotaType === "premium_interactions"
              ? "Premium interactions"
              : quotaType === "chat"
                ? "Chat requests"
                : "Completions",
          remainingPercentage: snapshot.remainingPercentage,
          usedAmount: Math.max(0, snapshot.usedRequests),
          limitAmount: snapshot.isUnlimitedEntitlement
            ? null
            : Math.max(0, snapshot.entitlementRequests),
          unit: "requests",
          resetDate: snapshot.resetDate ?? null,
          isUnlimited: snapshot.isUnlimitedEntitlement,
        });
      } catch {
        return null;
      } finally {
        await client.stop().catch(() => undefined);
      }
    }).pipe(
      Effect.timeout(15_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    return result;
  });

  const readProviderQuotas = Effect.fn("UsageService.readProviderQuotas")(function* (
    settings: ServerSettingsConfig,
    codexDir: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (now - providerQuotasReadAtMs < 5 * 60 * 1000) return providerQuotas;

    // These are independent provider-owned sources. Run them together so a
    // slow CLI cannot make the other quota checks wait behind it.
    const [claudeQuotas, codexQuotas, copilot] = yield* Effect.all(
      [
        (settings.providers.claudeAgent.enabled
          ? runClaudeUsageCommand(settings)
          : Effect.succeed(null)
        ).pipe(Effect.map((output) => (output ? parseClaudeUsageCommandOutput(output) : []))),
        Effect.promise(() => readLatestCodexRateLimits(codexDir)).pipe(
          Effect.catchCause(() => Effect.succeed([] as readonly string[])),
          Effect.map((lines) => lines.flatMap(parseCodexRateLimitsLine)),
        ),
        // A Copilot tile is only honest for someone who runs Copilot: gate it
        // on the setting rather than on the binary happening to be on PATH,
        // or every user gets a permanent "unavailable" row for a provider
        // they never enabled.
        settings.providers.githubCopilot.enabled ? readCopilotQuota() : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    );

    providerQuotas = [
      ...(claudeQuotas.length > 0
        ? claudeQuotas
        : [unavailableQuota("claude", "Claude Code quota is unavailable.")]),
      ...(codexQuotas.length > 0
        ? codexQuotas
        : [unavailableQuota("codex", "Codex quota is unavailable.")]),
      ...(settings.providers.githubCopilot.enabled
        ? [copilot ?? unavailableQuota("copilot", "Copilot quota is unavailable.")]
        : []),
    ];
    // Stamped after the reads, not before: marking the cache fresh up front
    // hands a concurrent reader the previous (or empty) value as though it
    // were current, and leaves an interrupted first read "fresh" for 5 minutes.
    providerQuotasReadAtMs = yield* Clock.currentTimeMillis;
    return providerQuotas;
  });

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const ensureRates = Effect.fn("UsageService.ensureRates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < RATES_TTL_MS) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
  });

  /**
   * Claude's config dir is the home itself when overridden, but a default
   * install nests transcripts under `~/.claude/projects`. Probe both.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : path.join(homePath, "projects");
    });

  /** Resolves the transcript directory for each provider. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsConfig,
  ) {
    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
    const claudeDir = yield* resolveClaudeTranscriptDir(claudeHome);
    const codexLayout = yield* resolveCodexHomeLayout(settings.providers.codex);

    return [
      { provider: "claude" as const, dir: claudeDir },
      { provider: "codex" as const, dir: path.join(codexLayout.sharedHomePath, "sessions") },
    ];
  });

  /**
   * Loads the persisted scan cache exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(scanCachePath).pipe(
        Effect.flatMap((raw) => decodeScanCacheFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const [path, entry] of decodeScanCache(document)) fileCache.set(path, entry);
    }),
  );

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale.
    yield* encodeScanCacheFile(encodeScanCache(fileCache)).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.void),
    );
  });

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<readonly UsageRecord[]> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return cached.records;
      }

      const parsed = yield* Effect.promise(() => readTranscriptRecords(filePath, provider));
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return [];
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile(parsed);

      fileCache.set(filePath, { size, mtimeMs, provider, records });
      cacheDirty = true;
      return records;
    });

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    // A settings failure must surface as an error: swallowing it here would
    // present "zero usage from every provider" as a valid answer.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Server settings could not be read.",
            cause: Cause.squash(cause),
          }),
      ),
    );

    yield* ensureRates();
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so `readSummary` stays context-free.
    const dirs = yield* resolveTranscriptDirs(settings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const codexDir = dirs.find((entry) => entry.provider === "codex")?.dir ?? "";
    yield* readProviderQuotas(settings, codexDir);
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
    });

    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];

    for (const { provider, dir } of dirs) {
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));

      if (!exists) {
        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No transcript directory on this environment.",
        });
        continue;
      }

      walkedRoots.push(dir);
      const files = yield* Effect.promise(() => listTranscriptFiles(dir, windowStartMs));
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of files) {
        livePaths.add(file.path);
        const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        if (records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const record of records) {
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        status: "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message: null,
      });
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    if (pruned > 0) cacheDirty = true;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      providerQuotas,
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  return { readSummary } as const;
});

export const layer = Layer.effect(UsageService, make);
