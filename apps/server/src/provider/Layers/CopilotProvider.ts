import type * as EffectAcpSchema from "effect-acp/schema";
import type { CopilotSettings, ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeCopilotAcpRuntime } from "../acp/CursorAcpSupport.ts";
import { discoverSharedSkillsForProvider } from "../SharedSkillCatalog.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

export function buildInitialCopilotProviderSnapshot(
  settings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking GitHub Copilot CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "GitHub Copilot is disabled in T3 Code settings.",
          },
    });
  });
}

function copilotCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const reasoning = configOptions?.find(
    (option) => option.type === "select" && option.category === "thought_level",
  );
  if (!reasoning || reasoning.type !== "select") {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoning",
        label: reasoning.name.trim() || "Reasoning Effort",
        options: reasoning.options
          .flatMap((option) =>
            "value" in option
              ? [{ value: option.value, label: option.name }]
              : option.options.map((nested) => ({ value: nested.value, label: nested.name })),
          )
          .filter((option) => option.value.length > 0 && option.label.length > 0),
      }),
    ],
  });
}

function buildDiscoveredModels(
  setup:
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const availableModels = setup.models?.availableModels ?? [];
  const seen = new Set<string>();
  return availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: copilotCapabilities(configOptions),
      } satisfies ServerProviderModel,
    ];
  });
}

const discoverCopilotModelsViaAcp = (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeCopilotAcpRuntime({
      cursorSettings: settings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return {
      models: buildDiscoveredModels(
        started.sessionSetupResult,
        started.sessionSetupResult.configOptions,
      ),
      configOptions: started.sessionSetupResult.configOptions,
    };
  }).pipe(Effect.scoped);

const runCopilotVersionCommand = (settings: CopilotSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "copilot";
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(command, ["--version"], { env: environment }),
    );
  });

function authForFailure(cause: unknown): {
  readonly status: "unauthenticated" | "unknown";
  readonly type?: string;
  readonly label?: string;
} {
  const detail = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  return detail.includes("auth") || detail.includes("login")
    ? { status: "unauthenticated", type: "copilot-login", label: "Copilot CLI login" }
    : { status: "unknown" };
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
  if (!settings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runCopilotVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const cause = versionResult.failure;
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(cause),
        version: null,
        status: "error",
        auth: authForFailure(cause),
        message: isCommandMissingCause(cause)
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute GitHub Copilot CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI timed out while checking its version.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  const discovery = yield* discoverCopilotModelsViaAcp(settings, environment, cwd).pipe(
    Effect.timeoutOption(ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discovery) || Option.isNone(discovery.value)) {
    const cause = Exit.isFailure(discovery) ? discovery.cause : undefined;
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: cause ? "warning" : "error",
        auth: cause ? authForFailure(cause) : { status: "unknown" },
        message: cause
          ? "GitHub Copilot CLI is installed but ACP startup failed. Run `copilot login` and try again."
          : "GitHub Copilot CLI timed out during ACP startup.",
      },
    });
  }

  const discovered = discovery.value.value;
  const models = providerModelsFromSettings(
    discovered.models,
    settings.customModels,
    copilotCapabilities(discovered.configOptions),
  );
  const skills = yield* discoverSharedSkillsForProvider(cwd, environment);
  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    skills,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated", type: "copilot-login", label: "Copilot CLI login" },
    },
  });
});
