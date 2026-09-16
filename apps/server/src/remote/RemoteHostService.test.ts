import { describe, expect, it } from "vite-plus/test";

import { controlPathForTarget, multiplexArgs, parseProbeOutput } from "./RemoteHostService.ts";

const target = {
  alias: "buildbox",
  hostname: "buildbox.example.com",
  username: "deploy",
  port: 2222,
};

const probedAt = "2026-01-01T00:00:00.000Z";

describe("parseProbeOutput", () => {
  it("reads a fully capable GNU host", () => {
    const capabilities = parseProbeOutput(
      [
        "rsync=rsync  version 3.2.7  protocol version 31",
        "bash=/usr/bin/bash",
        "shell=/bin/bash",
        "findnewer=1",
      ].join("\n"),
      probedAt,
    );

    expect(capabilities.rsyncVersion).toBe("rsync  version 3.2.7  protocol version 31");
    expect(capabilities.loginShell).toBe("bash");
    expect(capabilities.shellDialect).toBe("posix");
    expect(capabilities.supportsFindNewer).toBe(true);
    expect(capabilities.probedAt).toBe(probedAt);
  });

  it("reports a missing rsync as null rather than an empty string", () => {
    const capabilities = parseProbeOutput("rsync=\nbash=\nshell=/bin/sh\nfindnewer=0", probedAt);
    expect(capabilities.rsyncVersion).toBeNull();
  });

  it("falls back to sh when the host has no bash", () => {
    const capabilities = parseProbeOutput("rsync=\nbash=\nshell=/bin/sh\nfindnewer=0", probedAt);
    expect(capabilities.loginShell).toBe("sh");
  });

  it("recognizes non-POSIX login shells", () => {
    expect(parseProbeOutput("shell=/usr/bin/fish", probedAt).shellDialect).toBe("fish");
    expect(parseProbeOutput("shell=/bin/tcsh", probedAt).shellDialect).toBe("csh");
    expect(parseProbeOutput("shell=/bin/zsh", probedAt).shellDialect).toBe("posix");
  });

  it("reports an unknown dialect when SHELL is unset", () => {
    expect(parseProbeOutput("shell=", probedAt).shellDialect).toBe("unknown");
  });

  it("survives CRLF line endings and unrelated banner noise", () => {
    const capabilities = parseProbeOutput(
      "Welcome to buildbox!\r\nrsync=rsync 3.2.7\r\nbash=/bin/bash\r\nfindnewer=1\r\n",
      probedAt,
    );
    expect(capabilities.rsyncVersion).toBe("rsync 3.2.7");
    expect(capabilities.supportsFindNewer).toBe(true);
  });

  it("treats anything but an explicit 1 as no find -newer", () => {
    expect(parseProbeOutput("findnewer=0", probedAt).supportsFindNewer).toBe(false);
    expect(parseProbeOutput("", probedAt).supportsFindNewer).toBe(false);
  });
});

describe("controlPathForTarget", () => {
  it("stays well inside the ~104 byte sun_path limit for unix sockets", () => {
    // The whole point of hashing instead of using the state dir: a socket path that is too
    // long fails at connect time with a confusing error, on macOS especially.
    expect(Buffer.byteLength(controlPathForTarget(target))).toBeLessThan(104);
  });

  it("is stable for one target and distinct across targets", () => {
    expect(controlPathForTarget(target)).toBe(controlPathForTarget({ ...target }));
    expect(controlPathForTarget(target)).not.toBe(
      controlPathForTarget({ ...target, username: "other" }),
    );
    expect(controlPathForTarget(target)).not.toBe(controlPathForTarget({ ...target, port: 22 }));
  });
});

describe("multiplexArgs", () => {
  it("enables a persistent master on unix so a turn pays one handshake", () => {
    const args = multiplexArgs({ target, platform: "darwin" });
    expect(args).toContain("ControlMaster=auto");
    expect(args.some((arg) => arg.startsWith("ControlPath="))).toBe(true);
    expect(args.some((arg) => arg.startsWith("ControlPersist="))).toBe(true);
  });

  it("goes without on Windows, which has no unix-socket ControlMaster", () => {
    expect(multiplexArgs({ target, platform: "win32" })).toEqual([]);
  });
});
