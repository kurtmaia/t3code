/**
 * Turning a command into something safe to hand `ssh`.
 *
 * `ssh host <args>` does not exec argv the way `spawn` does: it joins the arguments with
 * spaces and feeds the result to the remote user's *login* shell. Everything here exists
 * because of that one fact - the remote side is a shell, so anything we send has to survive
 * a round of shell parsing that we do not control.
 */

/**
 * Wrap a string so a POSIX shell reproduces it byte for byte.
 *
 * Single quotes are the only quoting form that suppresses every expansion, so the string is
 * wrapped in them and each embedded quote is closed, escaped, and reopened. This is also why
 * it is safe under fish and csh: none of them expand inside single quotes.
 */
export function quoteForRemoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the argv that runs `command` in `cwd` on the remote host.
 *
 * The command is wrapped in a login shell so PATH managers that only write to shell rc files
 * - nvm, pyenv, mise, asdf - are on PATH. `sh -lc` reads `/etc/profile` and `~/.profile` only,
 * which misses the very common case of nvm installed into `~/.bashrc`, so bash is preferred
 * when the host has it.
 *
 * The whole thing is passed as ONE argument. Passing it as several would let the remote login
 * shell re-split on whitespace, which is how paths with spaces silently become two arguments.
 */
export function buildRemoteCommandArgs(input: {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly loginShell?: "bash" | "sh" | undefined;
}): ReadonlyArray<string> {
  const shell = input.loginShell ?? "sh";
  const script =
    input.cwd === undefined
      ? input.command
      : `cd ${quoteForRemoteShell(input.cwd)} && ${input.command}`;
  return [`${shell} -lc ${quoteForRemoteShell(script)}`];
}
