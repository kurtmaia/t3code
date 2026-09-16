/**
 * RemoteHostService - resolving, probing, and running commands on an ssh host.
 *
 * This is the only place in the server that talks to `ssh` for remote-backed projects. It
 * layers three things on top of `@t3tools/ssh`, which otherwise serves the desktop's remote
 * *server* launcher:
 *
 * 1. connection multiplexing, so a chatty turn pays one handshake instead of dozens;
 * 2. login-shell wrapping, so the host's real toolchain is on PATH;
 * 3. a capability probe, so the sync layer knows what this host can actually do.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { RemoteHostCapabilities, RemoteShellDialect } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import {
  runSshCommand,
  resolveSshTarget,
  targetConnectionKey,
  type SshCommandResult,
} from "@t3tools/ssh/command";
import type { SshCommandError, SshInvalidTargetError } from "@t3tools/ssh/errors";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildRemoteCommandArgs } from "./RemoteShell.ts";

const PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * How long a multiplexed master lingers with no channels open. Long enough that a turn's
 * worth of commands reuses one connection, short enough that a laptop closing its lid does
 * not leave a dead socket around for the rest of the day.
 */
const CONTROL_PERSIST_SECONDS = 60;

/**
 * ControlPath is bound to a unix socket, and `sun_path` caps out near 104 bytes on macOS.
 * The state directory is nowhere near short enough, so sockets live in a private directory
 * under the system temp root and are named by a hash of the connection tuple.
 */
function controlSocketDirectory(): string {
  const directory = NodePath.join(NodeOS.tmpdir(), `.t3-ssh-${process.getuid?.() ?? 0}`);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function controlPathForTarget(target: DesktopSshEnvironmentTarget): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(targetConnectionKey(target))
    .digest("hex")
    .slice(0, 16);
  return NodePath.join(controlSocketDirectory(), digest);
}

/**
 * Multiplexing options for one connection.
 *
 * Deliberately not shared with `packages/ssh/src/tunnel.ts`, which sets `ControlMaster=no` on
 * purpose: a port-forward owns its connection for its whole life, so pooling would only make
 * its teardown ambiguous. Remote projects have the opposite shape - many short commands - so
 * they want the opposite policy.
 *
 * Windows OpenSSH has no unix-socket ControlMaster, so it simply goes without.
 */
export function multiplexArgs(input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly platform: NodeJS.Platform;
}): ReadonlyArray<string> {
  if (input.platform === "win32") {
    return [];
  }
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPathForTarget(input.target)}`,
    "-o",
    `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
  ];
}

export interface RemoteRunInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly loginShell?: "bash" | "sh" | undefined;
  readonly timeoutMs?: number | undefined;
  readonly stdin?: string | undefined;
}

export type RemoteHostError = SshCommandError | SshInvalidTargetError;

export class RemoteHostService extends Context.Service<
  RemoteHostService,
  {
    /** Resolve an ssh alias through `ssh -G` into a concrete host/user/port. */
    readonly resolve: (host: string) => Effect.Effect<DesktopSshEnvironmentTarget, RemoteHostError>;
    /** Run one command in a login shell on the host, multiplexed. */
    readonly run: (input: RemoteRunInput) => Effect.Effect<SshCommandResult, RemoteHostError>;
    /** Ask the host what it supports. Runs once at bind time, not per operation. */
    readonly probe: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<RemoteHostCapabilities, RemoteHostError>;
  }
>()("t3/remote/RemoteHostService") {}

/**
 * One round trip that answers every capability question.
 *
 * Written for `sh` because we do not yet know whether bash exists - that is one of the things
 * being asked. `command -v` is POSIX; `which` is not.
 */
const PROBE_SCRIPT = [
  'printf "rsync=%s\\n" "$(rsync --version 2>/dev/null | head -n 1 || true)"',
  'printf "bash=%s\\n" "$(command -v bash 2>/dev/null || true)"',
  'printf "shell=%s\\n" "${SHELL:-}"',
  // `find -newer` backs the scoped down-sync. Probe it rather than assume: busybox find
  // reports a version but still refuses several GNU predicates.
  'if find . -maxdepth 0 -newer . >/dev/null 2>&1; then printf "findnewer=1\\n"; else printf "findnewer=0\\n"; fi',
].join("; ");

export function parseProbeOutput(stdout: string, probedAt: string): RemoteHostCapabilities {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const index = line.indexOf("=");
    if (index > 0) {
      values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }

  const rsync = values.get("rsync") ?? "";
  const loginShellPath = values.get("shell") ?? "";
  const shellName = loginShellPath.split("/").pop() ?? "";

  const shellDialect: RemoteShellDialect =
    shellName === "fish"
      ? "fish"
      : shellName === "csh" || shellName === "tcsh"
        ? "csh"
        : shellName === ""
          ? "unknown"
          : "posix";

  return {
    rsyncVersion: rsync.length > 0 ? rsync : null,
    shellDialect,
    loginShell: (values.get("bash") ?? "").length > 0 ? "bash" : "sh",
    supportsFindNewer: values.get("findnewer") === "1",
    probedAt,
  };
}

const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;

  // `@t3tools/ssh` needs the platform trio to spawn `ssh` and to write its askpass helper.
  // They are captured once here so callers of this service do not have to carry them.
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const withPlatform = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const run = (input: RemoteRunInput) =>
    withPlatform(
      runSshCommand(input.target, {
        preHostArgs: multiplexArgs({ target: input.target, platform }),
        remoteCommandArgs: buildRemoteCommandArgs({
          command: input.command,
          cwd: input.cwd,
          loginShell: input.loginShell,
        }),
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        timeoutMs: input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      }),
    );

  const probe = (target: DesktopSshEnvironmentTarget) =>
    Effect.gen(function* () {
      const probedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const result = yield* run({
        target,
        command: PROBE_SCRIPT,
        // Probe with plain `sh`: asking whether bash exists must not require bash.
        loginShell: "sh",
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return parseProbeOutput(result.stdout, probedAt);
    });

  return RemoteHostService.of({
    resolve: (host) => withPlatform(resolveSshTarget(host)),
    run,
    probe,
  });
});

export const layer = Layer.effect(RemoteHostService, make);
