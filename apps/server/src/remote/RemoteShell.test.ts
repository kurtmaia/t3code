import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { buildRemoteCommandArgs, quoteForRemoteShell } from "./RemoteShell.ts";

/**
 * Round-trips a value through a real `/bin/sh` the way ssh would, proving the quoting
 * survives an actual shell rather than only matching a string we expected.
 */
function roundTripThroughSh(value: string): string {
  return NodeChildProcess.execFileSync(
    "/bin/sh",
    ["-c", `printf %s ${quoteForRemoteShell(value)}`],
    {
      encoding: "utf8",
    },
  );
}

describe("quoteForRemoteShell", () => {
  it("survives the characters that break naive quoting", () => {
    for (const value of [
      "plain",
      "with space",
      "single'quote",
      'double"quote',
      "$HOME",
      "`whoami`",
      "$(whoami)",
      "back\\slash",
      "semi;colon",
      "pipe|char",
      "new\nline",
      "glob*star",
      "tilde~expand",
      "emoji-🎉",
    ]) {
      expect(roundTripThroughSh(value)).toBe(value);
    }
  });

  it("neutralizes an attempt to end the quoted string and append a command", () => {
    const hostile = `'; rm -rf /tmp/nope; echo '`;
    expect(roundTripThroughSh(hostile)).toBe(hostile);
  });
});

/** Undo the outer ssh-level quoting, yielding the script the remote login shell receives. */
function unwrapForRemoteShell(args: ReadonlyArray<string>): string {
  const script = args[0] ?? "";
  const inner = script.slice(script.indexOf(" -lc ") + " -lc ".length);
  return NodeChildProcess.execFileSync("/bin/sh", ["-c", `printf %s ${inner}`], {
    encoding: "utf8",
  });
}

describe("buildRemoteCommandArgs", () => {
  it("passes the whole script as one argument so the login shell cannot re-split it", () => {
    const args = buildRemoteCommandArgs({ command: "npm test", cwd: "/srv/my app" });
    expect(args).toHaveLength(1);
  });

  it("quotes a cwd containing spaces so it stays one path", () => {
    // The cwd is quoted, then the whole script is quoted again for ssh, so asserting on the
    // raw string would just be restating the escaping. Unwrap one layer and check what the
    // remote login shell would actually be handed.
    expect(
      unwrapForRemoteShell(buildRemoteCommandArgs({ command: "npm test", cwd: "/srv/my app" })),
    ).toBe(`cd '/srv/my app' && npm test`);
  });

  it("omits the cd entirely when no cwd is given", () => {
    const [script] = buildRemoteCommandArgs({ command: "rsync --version" });
    expect(script).not.toContain("cd ");
  });

  it("defaults to sh and honors an explicit bash", () => {
    expect(buildRemoteCommandArgs({ command: "x" })[0]).toMatch(/^sh -lc /u);
    expect(buildRemoteCommandArgs({ command: "x", loginShell: "bash" })[0]).toMatch(/^bash -lc /u);
  });

  it("always uses a login shell, so nvm and mise are on PATH", () => {
    expect(buildRemoteCommandArgs({ command: "node -v" })[0]).toContain("-lc");
  });

  it("runs in the requested directory when a real shell executes it", () => {
    const script = unwrapForRemoteShell(buildRemoteCommandArgs({ command: "pwd", cwd: "/tmp" }));
    expect(
      NodeChildProcess.execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" }).trim(),
    ).toBe("/tmp");
  });

  it("keeps a directory with spaces intact when a real shell executes it", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 remote "));
    try {
      const script = unwrapForRemoteShell(
        buildRemoteCommandArgs({ command: "pwd", cwd: directory }),
      );
      expect(
        NodeChildProcess.execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" }).trim(),
      ).toBe(directory);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
