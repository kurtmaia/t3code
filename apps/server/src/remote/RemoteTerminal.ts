/**
 * Turning a remote binding into a PTY that lands on the remote host.
 *
 * No new PtyAdapter is needed: a remote terminal is an ordinary local PTY whose process
 * happens to be `ssh`. The adapter still owns the tty, so resize, signals and history all
 * work the way they already do.
 */
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";

import { quoteForRemoteShell } from "./RemoteShell.ts";

export interface RemoteTerminalTarget {
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePath: string;
  readonly loginShell: "bash" | "sh";
  /** Multiplexing options, so a terminal reuses the connection the sync layer already opened. */
  readonly multiplexArgs: ReadonlyArray<string>;
}

export interface RemoteShellCandidate {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Build the `ssh` invocation for an interactive remote terminal.
 *
 * `-t` is forced twice. Once is not enough: ssh only allocates a tty when its own stdin is
 * one, and the PTY adapter's stdin is a pipe as far as ssh can tell. Without a remote tty
 * the shell runs non-interactively - no prompt, no job control, and Ctrl-C never reaches the
 * remote process, which is the difference between cancelling a build and orphaning it.
 *
 * `exec $SHELL -l` replaces the wrapper rather than nesting a second shell, so exiting the
 * user's shell closes the session instead of dropping them into a bare `sh`.
 */
export function buildRemoteTerminalCandidate(remote: RemoteTerminalTarget): RemoteShellCandidate {
  const destination = remote.target.username
    ? `${remote.target.username}@${remote.target.hostname}`
    : remote.target.hostname;

  return {
    shell: "ssh",
    args: [
      "-tt",
      ...(remote.target.port !== null ? ["-p", String(remote.target.port)] : []),
      ...remote.multiplexArgs,
      destination,
      `cd ${quoteForRemoteShell(remote.remotePath)} && exec ${remote.loginShell === "bash" ? "${SHELL:-/bin/bash}" : "${SHELL:-/bin/sh}"} -l`,
    ],
  };
}
