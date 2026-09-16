import { describe, expect, it } from "vite-plus/test";

import { buildRemoteTerminalCandidate } from "./RemoteTerminal.ts";

const base = {
  target: { alias: "buildbox", hostname: "buildbox.example.com", username: "deploy", port: 2222 },
  remotePath: "/srv/app",
  loginShell: "bash" as const,
  multiplexArgs: ["-o", "ControlMaster=auto"],
};

describe("buildRemoteTerminalCandidate", () => {
  it("spawns ssh rather than a local shell", () => {
    expect(buildRemoteTerminalCandidate(base).shell).toBe("ssh");
  });

  it("forces a tty twice so Ctrl-C reaches the remote process", () => {
    // A single -t is conditional on ssh's own stdin being a tty, which it is not behind a
    // PTY adapter pipe. Without a remote tty an interrupted build is orphaned, not killed.
    expect(buildRemoteTerminalCandidate(base).args[0]).toBe("-tt");
  });

  it("carries the port and the multiplex options through", () => {
    const args = buildRemoteTerminalCandidate(base).args;
    expect(args).toContain("-p");
    expect(args).toContain("2222");
    expect(args).toContain("ControlMaster=auto");
  });

  it("omits -p when the host uses the default port", () => {
    const { args } = buildRemoteTerminalCandidate({
      ...base,
      target: { ...base.target, port: null },
    });
    expect(args).not.toContain("-p");
  });

  it("builds a user@host destination, and a bare host without a username", () => {
    expect(buildRemoteTerminalCandidate(base).args).toContain("deploy@buildbox.example.com");
    expect(
      buildRemoteTerminalCandidate({ ...base, target: { ...base.target, username: null } }).args,
    ).toContain("buildbox.example.com");
  });

  it("quotes a remote path containing spaces", () => {
    const { args } = buildRemoteTerminalCandidate({ ...base, remotePath: "/srv/my app" });
    expect(args.at(-1)).toContain(`cd '/srv/my app'`);
  });

  it("execs the login shell so exiting it closes the session", () => {
    const args = buildRemoteTerminalCandidate(base).args;
    const script = args.at(-1) ?? "";
    expect(script).toContain("exec ");
    expect(script).toContain("-l");
  });
});
