# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Where a provider's model list comes from

A provider snapshot's `models` array is built during the status probe, and each driver sources it
differently:

| Driver          | Source                                                            |
| --------------- | ----------------------------------------------------------------- |
| `codex`         | `model/list` over the app-server protocol                         |
| `cursor`        | `cursor/list_available_models` over ACP, hardcoded fallback       |
| `githubCopilot` | `availableModels` on the ACP session setup result                 |
| `opencode`      | the provider list served by the opencode server                   |
| `claudeAgent`   | built-in catalog unioned with the Agent SDK initialization result |
| `grok`          | built-in catalog only                                             |

Every driver then appends the user's custom slugs through `providerModelsFromSettings`.

Claude is the mixed case. [`ClaudeProvider.ts`][claudeprovider] keeps `CLAUDE_MODEL_CATALOG` because
the CLI reports no context-window field and has no notion of `ultracode` or `ultrathink`, so those
descriptors have to be written by hand. `mergeDiscoveredClaudeModels` unions the CLI's list into the
catalog under three rules:

- A catalog entry wins for its slug. It carries the curated option descriptors.
- Catalog entries follow the version gate alone. The CLI's list can echo a model configured in the
  user's settings or environment whatever the CLI version, so a listed catalog slug does not un-gate
  it; a hidden model stays hidden until Claude Code is upgraded.
- A slug the catalog has never seen is appended after the built-ins, with options synthesized from
  the SDK's `ModelInfo` flags, so a newly released model is usable without a T3 Code change and the
  curated first entry stays the default for new threads.

Discovery never subtracts, because the CLI's list is scoped to the signed-in account and the
filesystem setting sources in play.

The CLI reports picker rows, not canonical slugs: short labels (`default`, `opus`, `sonnet`) sit next
to full ids, with the context-window variant baked in (`claude-opus-5[1m]`). `parseClaudeModelValue`
splits the suffix back into a `contextWindow` option and keeps only values whose base is a concrete
`claude-*` id, normalized through `MODEL_SLUG_ALIASES_BY_PROVIDER`; the short labels are dropped
because the CLI repoints them at newer models over time, and a slug is a thread's durable model
identity that feeds usage pricing.

Synthesized capabilities are also cached by slug for `getClaudeModelCapabilities`, which the adapter
calls at send time. Without that, a discovered model would render options in the picker and then have
them dropped on the way to the CLI. Before a probe has run, or when it fails, a model outside the
catalog resolves against a permissive descriptor set that accepts any stored effort, fast-mode, or
context-window choice without defaulting any of them, so a turn the server sends from a stored
`thread.modelSelection` keeps its options across a restart. Clients still trim options against their
own snapshot, which lists only the catalog until the probe lands.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[claudeprovider]: ../../apps/server/src/provider/Layers/ClaudeProvider.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
