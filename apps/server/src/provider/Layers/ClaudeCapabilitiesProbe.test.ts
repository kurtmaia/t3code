import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  getBuiltInClaudeModelsForVersion,
  getClaudeModelCapabilities,
  isLegacyClaudeModel,
  mergeDiscoveredClaudeModels,
  normalizeClaudeCliEffort,
  parseClaudeInitializationModels,
  resolveClaudeContextWindow,
  resolveClaudeEffort,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("keeps only the Claude 5 family out of legacy models", () => {
  assert.deepStrictEqual(
    ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"].map((model) => [
      model,
      isLegacyClaudeModel(model),
    ]),
    [
      ["claude-fable-5", false],
      ["claude-opus-5", false],
      ["claude-sonnet-5", false],
      ["claude-opus-4-8", true],
    ],
  );
});

const discoveredOpus9 = () =>
  parseClaudeInitializationModels([
    {
      value: "claude-opus-9[1m]",
      displayName: "Opus 9",
      description: "Not in the catalog",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsFastMode: true,
    },
  ]);

it("adds unknown models after the catalog and leaves the version gate alone", () => {
  // A CLI old enough that the version gate hides Opus 5. The CLI may still
  // echo `claude-opus-5` from the user's settings, which proves nothing about
  // whether this version runs it, so the gate stands.
  const gated = getBuiltInClaudeModelsForVersion("2.1.0");
  assert.equal(
    gated.some((model) => model.slug === "claude-opus-5"),
    false,
  );

  const merged = mergeDiscoveredClaudeModels(gated, [
    ...parseClaudeInitializationModels([
      { value: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "Opus 5" },
      // A dated snapshot of a catalog model is the same model for the gate.
      { value: "claude-opus-5-20261015", displayName: "Opus 5", description: "Dated id" },
      { value: "claude-opus-4-5-20251101", displayName: "Opus 4.5", description: "Dated id" },
    ]),
    ...discoveredOpus9(),
  ]);

  assert.deepEqual(
    merged.map((model) => model.slug),
    [...gated.map((model) => model.slug), "claude-opus-9"],
  );
  assert.equal(merged.at(-1)?.isLegacy, undefined);
});

it("ignores the CLI's floating labels so an old CLI cannot un-gate a model", () => {
  const gated = getBuiltInClaudeModelsForVersion("2.1.0");
  assert.deepEqual(
    parseClaudeInitializationModels([
      { value: "opus[1m]", displayName: "Opus (1M context)", description: "Opus 4.x here" },
      { value: "sonnet", displayName: "Sonnet", description: "" },
      { value: "opusplan", displayName: "Opus Plan", description: "" },
    ]),
    [],
  );
  assert.deepEqual(mergeDiscoveredClaudeModels(gated, []), gated);
});

it("names discovered models the way the catalog names its own", () => {
  assert.deepEqual(
    parseClaudeInitializationModels([
      // The CLI labels this row "Fable". Shown verbatim next to the catalog's
      // "Claude Fable 5" it reads as a duplicate rather than a newer model.
      {
        value: "claude-fable-5-1[1m]",
        displayName: "Fable",
        description: "Fable 5.1 · Most capable for your hardest tasks",
      },
      { value: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5" },
      { value: "claude-neo", displayName: "Neo", description: "No version in the slug" },
      { value: "claude-opus-4-1-20250805", displayName: "Opus 4.1", description: "Dated id" },
      { value: "claude-3-5-sonnet-20241022", displayName: "Sonnet", description: "Old shape" },
    ]).map((model) => [model.slug, model.name]),
    [
      ["claude-fable-5-1", "Claude Fable 5.1"],
      ["claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-neo", "Neo"],
      ["claude-opus-4-1-20250805", "Claude Opus 4.1"],
      ["claude-3-5-sonnet-20241022", "Claude Sonnet 3.5"],
    ],
  );
});

it("leaves the catalog alone when the CLI reports no models", () => {
  const gated = getBuiltInClaudeModelsForVersion("2.1.219");
  assert.deepEqual(mergeDiscoveredClaudeModels(gated, []), gated);
});

it("resolves discovered model options the same way the picker rendered them", () => {
  mergeDiscoveredClaudeModels(getBuiltInClaudeModelsForVersion("2.1.219"), discoveredOpus9());

  // The adapter resolves capabilities by slug at send time; without discovery
  // feeding that lookup it would silently drop the options the picker offered.
  assert.deepEqual(
    getClaudeModelCapabilities("claude-opus-9").optionDescriptors?.map(
      (descriptor) => descriptor.id,
    ),
    ["effort", "fastMode", "contextWindow"],
  );
  assert.equal(normalizeClaudeCliEffort("xhigh", "claude-opus-9"), "xhigh");
  assert.equal(normalizeClaudeCliEffort("xhigh", "claude-opus-4-6"), "max");
});

it("honors a thread's stored options for a model the probe has not reported yet", () => {
  // A server restart runs turns before the status probe repopulates discovery;
  // the choices the picker persisted must not degrade in that window. This is
  // the adapter's own path: capabilities first, then the CLI mapping.
  const caps = getClaudeModelCapabilities("claude-never-probed");
  const effort = resolveClaudeEffort(caps, "xhigh");
  assert.equal(effort, "xhigh");
  assert.equal(normalizeClaudeCliEffort(effort, "claude-never-probed"), "xhigh");
  assert.equal(resolveClaudeEffort(caps, undefined), undefined, "no stored effort sends none");
  assert.equal(
    caps.optionDescriptors?.some(
      (descriptor) => descriptor.id === "fastMode" && descriptor.type === "boolean",
    ),
    true,
  );
  assert.equal(
    resolveClaudeContextWindow(
      createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-never-probed", [
        { id: "contextWindow", value: "1m" },
      ]),
    ),
    "1m",
  );
  assert.equal(
    resolveClaudeContextWindow(
      createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-never-probed", []),
    ),
    undefined,
  );
});

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const workspaceCwd = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspaceCwd, { recursive: true });

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
          "  process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          "    response: {",
          '      subtype: "success",',
          "      request_id: message.request_id,",
          "      response: {",
          '        commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "        agents: [],",
          '        output_style: "default",',
          '        available_output_styles: ["default"],',
          "        models: [",
          '          { value: "default", displayName: "Default (recommended)", description: "Opus with 1M context", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },',
          '          { value: "opus[1m]", displayName: "Opus (1M context)", description: "Opus 5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },',
          '          { value: "claude-opus-9[1m]", displayName: "Opus 9", description: "Not in the catalog", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsFastMode: true },',
          "        ],",
          '        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "      },",
          "    },",
          '  }) + "\\n");',
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.ok(capabilities);
      const { models, ...accountCapabilities } = capabilities;
      assert.deepEqual(accountCapabilities, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiProvider: undefined,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
      });

      // `default` and `opus[1m]` are menu labels rather than models; only the
      // concrete id survives, and its context-window suffix becomes an option.
      assert.deepEqual(
        models?.map((model) => model.slug),
        ["claude-opus-9"],
      );
      const unknownModel = models?.find((model) => model.slug === "claude-opus-9");
      assert.equal(unknownModel?.name, "Claude Opus 9");
      assert.deepEqual(
        unknownModel?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id),
        ["effort", "fastMode", "contextWindow"],
      );

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      const settingsFlagIndex = invocation.args.indexOf("--settings");
      assert.notEqual(settingsFlagIndex, -1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? "{}") as {
        readonly disableAllHooks?: boolean;
      };
      assert.equal(flagSettings.disableAllHooks, true);
    }).pipe(Effect.scoped),
  );
});
