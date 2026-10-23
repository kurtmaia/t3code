import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type ModelInfo as ClaudeModelInfo,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
const MINIMUM_CLAUDE_OPUS_5_VERSION = "2.1.219";
const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169";
const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";

const CURRENT_CLAUDE_MODELS = new Set(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]);

export function isLegacyClaudeModel(model: string): boolean {
  return !CURRENT_CLAUDE_MODELS.has(model);
}

const CLAUDE_MODEL_CATALOG: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Claude Code selects the 1M variant explicitly (`claude-opus-5[1m]`).
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildBooleanOptionDescriptor({
          id: "thinking",
          label: "Thinking",
        }),
      ],
    }),
  },
];

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = CLAUDE_MODEL_CATALOG.map((model) =>
  isLegacyClaudeModel(model.slug) ? { ...model, isLegacy: true } : model,
);

function supportsClaudeOpus5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_5_VERSION) >= 0 : false;
}

function supportsClaudeFable5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_FABLE_5_VERSION) >= 0 : false;
}

function supportsClaudeOpus48(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_8_VERSION) >= 0 : false;
}

function supportsClaudeOpus47(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_7_VERSION) >= 0 : false;
}

export function getBuiltInClaudeModelsForVersion(
  version: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  return BUILT_IN_MODELS.filter((model) => {
    if (model.slug === "claude-opus-5") {
      return supportsClaudeOpus5(version);
    }
    if (model.slug === "claude-fable-5") {
      return supportsClaudeFable5(version);
    }
    if (model.slug === "claude-opus-4-8") {
      return supportsClaudeOpus48(version);
    }
    if (model.slug === "claude-opus-4-7") {
      return supportsClaudeOpus47(version);
    }
    return true;
  });
}

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

function isBuiltInClaudeModel(model: string | null | undefined): boolean {
  return model !== null && model !== undefined && BUILT_IN_MODELS.some((m) => m.slug === model);
}

/**
 * Whether a slug names a catalog model, directly or as a dated snapshot of
 * one (`claude-opus-5-20261015`). The alias table only knows a few dates, and
 * a dated id is the usual way a configured model is echoed by the CLI, so the
 * version gate has to recognise it too.
 */
function isCatalogClaudeModelOrSnapshot(slug: string): boolean {
  return isBuiltInClaudeModel(slug) || isBuiltInClaudeModel(slug.replace(/-\d{8}$/, ""));
}

/** Catalog models whose CLI accepts `xhigh`; older ones get the strongest level they do accept. */
const BUILT_IN_XHIGH_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
]);

/**
 * Values the CLI lists that are selector labels rather than models. `default`
 * follows whatever Claude Code currently recommends, so persisting it as a
 * thread's model would silently change which model that thread ran on.
 */
const CLAUDE_MENU_PSEUDO_MODELS = new Set(["default", "auto"]);

const CLAUDE_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * Capabilities synthesized for models the built-in catalog has never seen,
 * keyed by slug and refreshed by every provider probe. {@link getClaudeModelCapabilities}
 * prefers these for a discovered model so the adapter resolves exactly the
 * options the picker rendered; before a probe has run it falls back to
 * {@link NON_CATALOG_CLAUDE_MODEL_CAPABILITIES}, which accepts any stored choice.
 */
const discoveredClaudeCapabilities = new Map<string, ModelCapabilities>();

/**
 * Split a CLI model value into a canonical slug plus the context-window variant
 * baked into it. The CLI reports `claude-opus-5[1m]`; T3 stores `claude-opus-5`
 * and a `contextWindow` option, and {@link resolveClaudeApiModelId} re-appends
 * the suffix on the way back out.
 */
function parseClaudeModelValue(
  value: string,
): { readonly slug: string; readonly contextWindow: string | undefined } | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const variant = trimmed.match(/^(.+?)\[([^\]]+)\]$/);
  const base = (variant?.[1] ?? trimmed).trim();
  if (!base || CLAUDE_MENU_PSEUDO_MODELS.has(base.toLowerCase())) {
    return undefined;
  }

  // Only a concrete `claude-*` id names a model. Short labels such as `opus`
  // or `sonnet` are selectors the CLI repoints at newer models over time, so
  // an old CLI's `opus` must not be read as today's Opus: that would undo the
  // version gate the catalog relies on.
  if (!base.toLowerCase().startsWith("claude-")) {
    return undefined;
  }

  const slug = normalizeModelSlug(base.toLowerCase(), CLAUDE_DRIVER_KIND);
  if (!slug || !slug.startsWith("claude-")) {
    return undefined;
  }

  return { slug, contextWindow: variant?.[2]?.trim().toLowerCase() };
}

/**
 * Name a discovered model the way the catalog names its own entries.
 *
 * The CLI's `displayName` is the picker row's label, not the model's name: the
 * row for `claude-fable-5-1` is called "Fable", which sits next to the catalog's
 * "Claude Fable 5" looking like a duplicate of it. The slug carries the version
 * the label drops, so `claude-fable-5-1` becomes "Claude Fable 5.1".
 *
 * Returns undefined for a slug that does not split into a family and a version,
 * leaving the caller to fall back to whatever the CLI reported.
 */
function claudeModelDisplayName(slug: string): string | undefined {
  const segments = slug.split("-");
  if (segments[0] !== "claude" || segments.length < 3) {
    return undefined;
  }

  const family: Array<string> = [];
  const version: Array<string> = [];
  const rest = segments.slice(1);
  rest.forEach((segment, index) => {
    // Dated ids (`claude-opus-4-1-20250805`) end in a release date the catalog
    // never shows; older ids put the family after the version
    // (`claude-3-5-sonnet`), so the two are collected independently.
    if (index === rest.length - 1 && /^\d{8}$/.test(segment)) {
      return;
    }
    if (/^\d+$/.test(segment)) {
      version.push(segment);
    } else {
      family.push(segment);
    }
  });

  if (family.length === 0 || version.length === 0) {
    return undefined;
  }

  const familyLabel = family
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
  return `Claude ${familyLabel} ${version.join(".")}`;
}

function buildDiscoveredClaudeCapabilities(
  info: ClaudeModelInfo,
  contextWindows: ReadonlySet<string>,
): ModelCapabilities {
  const optionDescriptors = [];

  const effortLevels = info.supportsEffort ? (info.supportedEffortLevels ?? []) : [];
  if (effortLevels.length > 0) {
    const options: Array<{
      value: string;
      label: string;
      description?: string;
      isDefault?: boolean;
    }> = effortLevels.map((level) => ({
      value: level,
      label: CLAUDE_EFFORT_LABELS[level] ?? level,
      ...(level === "high" ? { isDefault: true } : {}),
    }));
    // `ultracode` and `ultrathink` are T3/Claude Code concepts with no field in
    // the SDK's model info, so they follow the same rule the catalog uses.
    if (effortLevels.includes("xhigh")) {
      options.push({
        value: "ultracode",
        label: "Ultracode",
        description: "xhigh effort plus multi-agent workflow orchestration",
      });
    }
    options.push({ value: "ultrathink", label: "Ultrathink" });
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options,
        promptInjectedValues: ["ultrathink"],
      }),
    );
  }

  if (info.supportsFastMode) {
    optionDescriptors.push(buildBooleanOptionDescriptor({ id: "fastMode", label: "Fast Mode" }));
  }

  if (contextWindows.has("1m")) {
    // 1M is opt-in in Claude Code and billed separately, so a model the
    // catalog has never seen starts on the standard window like Sonnet does.
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: "contextWindow",
        label: "Context Window",
        options: [
          { value: "200k", label: "200k", isDefault: true },
          { value: "1m", label: "1M" },
        ],
      }),
    );
  }

  return createModelCapabilities({ optionDescriptors });
}

/**
 * Turn the model list carried by the SDK initialization result into provider
 * models. The CLI reports one entry per picker row, so several rows can collapse
 * onto one slug (`opus` and `opus[1m]`); their context-window variants merge.
 */
export function parseClaudeInitializationModels(
  models: ReadonlyArray<ClaudeModelInfo> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const bySlug = new Map<
    string,
    { readonly info: ClaudeModelInfo; readonly contextWindows: Set<string> }
  >();

  for (const model of models ?? []) {
    const parsed = parseClaudeModelValue(model.value);
    if (!parsed) {
      continue;
    }

    const existing = bySlug.get(parsed.slug);
    if (existing) {
      if (parsed.contextWindow) {
        existing.contextWindows.add(parsed.contextWindow);
      }
      continue;
    }

    bySlug.set(parsed.slug, {
      info: model,
      contextWindows: new Set(parsed.contextWindow ? [parsed.contextWindow] : []),
    });
  }

  return [...bySlug].map(([slug, entry]) => ({
    slug,
    name: claudeModelDisplayName(slug) ?? nonEmptyProbeString(entry.info.displayName) ?? slug,
    isCustom: false,
    capabilities: buildDiscoveredClaudeCapabilities(entry.info, entry.contextWindows),
  }));
}

/**
 * Add the CLI's live model list to the version-gated catalog.
 *
 * Discovery only ever adds slugs the catalog has never seen, appended after
 * the built-ins so the curated first entry stays the default for new threads.
 * Catalog models follow the version gate alone: the CLI's list can echo a
 * model configured in the user's settings or environment regardless of
 * whether that CLI version runs it, so a listed catalog slug is not evidence
 * enough to un-gate it. Nothing is removed — the CLI's list reflects the
 * signed-in account's current entitlements and filesystem settings, and a
 * model missing from it may still be usable.
 */
export function mergeDiscoveredClaudeModels(
  versionGatedModels: ReadonlyArray<ServerProviderModel>,
  discoveredModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  if (discoveredModels.length === 0) {
    return versionGatedModels;
  }

  const seenSlugs = new Set(versionGatedModels.map((model) => model.slug));
  const unknownModels: Array<ServerProviderModel> = [];
  for (const model of discoveredModels) {
    if (seenSlugs.has(model.slug) || isCatalogClaudeModelOrSnapshot(model.slug)) {
      continue;
    }
    seenSlugs.add(model.slug);
    unknownModels.push(model);
    if (model.capabilities) {
      discoveredClaudeCapabilities.set(model.slug, model.capabilities);
    }
  }

  return unknownModels.length === 0
    ? versionGatedModels
    : [...versionGatedModels, ...unknownModels];
}

function formatClaudeOpus5UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Opus 5. Upgrade to v${MINIMUM_CLAUDE_OPUS_5_VERSION} or newer to access it.`;
}

function formatClaudeFable5UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Fable 5. Upgrade to v${MINIMUM_CLAUDE_FABLE_5_VERSION} or newer to access it.`;
}

function formatClaudeOpus48UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Opus 4.8. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_8_VERSION} or newer to access it.`;
}

function formatClaudeOpus47UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for Claude Opus 4.7. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_7_VERSION} or newer to access it.`;
}

/**
 * What the adapter may send for a model outside the catalog when discovery
 * has not described it: the picker never offers these options for such a
 * model, but a thread that chose them while the model was discovered keeps
 * them across a restart, before the probe has run or when it fails. No value
 * is a default, so an unset option still means "send nothing".
 */
const NON_CATALOG_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
        { value: "ultracode", label: "Ultracode" },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      promptInjectedValues: ["ultrathink"],
    }),
    buildBooleanOptionDescriptor({ id: "fastMode", label: "Fast Mode" }),
    buildSelectOptionDescriptor({
      id: "contextWindow",
      label: "Context Window",
      options: [
        { value: "200k", label: "200k" },
        { value: "1m", label: "1M" },
      ],
    }),
  ],
});

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  if (!slug) {
    return DEFAULT_CLAUDE_MODEL_CAPABILITIES;
  }
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    discoveredClaudeCapabilities.get(slug) ??
    NON_CATALOG_CLAUDE_MODEL_CAPABILITIES
  );
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): `ultracode` is a
 * Claude Code setting that pairs with `xhigh`, `ultrathink` is filtered out
 * because it is a prompt-prefix mode, and older model compatibility mappings
 * are preserved for current Claude Code behavior.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  if (effort === "ultracode") {
    return "xhigh";
  }
  // Models outside the catalog, discovered or custom, pass `xhigh` through:
  // the picker only offered it because the CLI reported it, and that must
  // hold before a probe has run as much as after one.
  if (effort === "xhigh" && isBuiltInClaudeModel(model) && !BUILT_IN_XHIGH_MODELS.has(model!)) {
    return "max";
  }
  if (effort === "max" && model === "claude-sonnet-4-6") {
    return "high";
  }
  return effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeModelCapabilities(modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  switch (resolveClaudeContextWindow(modelSelection)) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /**
   * Models the CLI itself offers, unioned into the catalog by the snapshot.
   * Optional because older CLIs omit the field from their init response.
   */
  readonly models?: ReadonlyArray<ServerProviderModel> | undefined;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd,
        }),
      });
      const init = await q.initializationResult();
      const account = init.account as
        | {
            readonly email?: string;
            readonly subscriptionType?: string;
            readonly tokenSource?: string;
            readonly apiProvider?: string;
          }
        | undefined;
      return {
        email: account?.email,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        apiProvider: account?.apiProvider,
        slashCommands: parseClaudeInitializationCommands(init.commands),
        models: parseClaudeInitializationModels(init.models),
      } satisfies ClaudeCapabilitiesProbe;
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const versionUpgradeMessage = supportsClaudeOpus5(parsedVersion)
    ? undefined
    : supportsClaudeFable5(parsedVersion)
      ? formatClaudeOpus5UpgradeMessage(parsedVersion)
      : supportsClaudeOpus48(parsedVersion)
        ? formatClaudeFable5UpgradeMessage(parsedVersion)
        : supportsClaudeOpus47(parsedVersion)
          ? formatClaudeOpus48UpgradeMessage(parsedVersion)
          : formatClaudeOpus47UpgradeMessage(parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = capabilities?.slashCommands ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);
  const models = providerModelsFromSettings(
    mergeDiscoveredClaudeModels(
      getBuiltInClaudeModelsForVersion(parsedVersion),
      capabilities?.models ?? [],
    ),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
