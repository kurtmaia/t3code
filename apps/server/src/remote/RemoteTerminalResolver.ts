/**
 * Deciding whether a terminal opens locally or on a bound remote host.
 *
 * The terminal manager asks this for every session it starts. Resolution is server-side on
 * purpose: `TerminalOpenInput` is a wire contract, so letting a client name the ssh host
 * would hand any connected client command execution on any machine the server can reach.
 * The only input from the client is a directory, and the answer comes from the project record.
 */
import * as NodePath from "node:path";

import type { ProjectionProject } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RemoteHostService } from "./RemoteHostService.ts";
import { multiplexArgs } from "./RemoteHostService.ts";
import type { RemoteTerminalTarget } from "./RemoteTerminal.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

/**
 * A project is bound to a host, but the host could not be resolved.
 *
 * This is deliberately an error rather than "no remote": falling back to a local terminal
 * would put the user on their own machine while the UI still shows the remote binding, and
 * every command they then ran would hit the wrong filesystem.
 */
export class RemoteTerminalResolutionError extends Schema.ErrorClass<RemoteTerminalResolutionError>(
  "RemoteTerminalResolutionError",
)({
  _tag: Schema.tag("RemoteTerminalResolutionError"),
  host: Schema.String,
  cwd: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Project at ${this.cwd} is bound to '${this.host}', which could not be reached: ${this.reason}`;
  }
}

export class RemoteTerminalResolver extends Context.Service<
  RemoteTerminalResolver,
  {
    readonly resolve: (
      cwd: string,
    ) => Effect.Effect<RemoteTerminalTarget | null, RemoteTerminalResolutionError>;
  }
>()("t3/remote/RemoteTerminalResolver") {}

/**
 * Pick the project that owns a directory.
 *
 * The longest matching workspace root wins, so a project nested inside another resolves to
 * the inner one rather than whichever happened to be created first.
 */
export function findOwningProject(
  projects: ReadonlyArray<ProjectionProject>,
  cwd: string,
): ProjectionProject | undefined {
  const normalized = NodePath.resolve(cwd);
  let best: ProjectionProject | undefined;
  for (const project of projects) {
    if (project.deletedAt !== null || project.remote == null) {
      continue;
    }
    const root = NodePath.resolve(project.workspaceRoot);
    const owns = normalized === root || normalized.startsWith(`${root}${NodePath.sep}`);
    if (owns && (best === undefined || root.length > NodePath.resolve(best.workspaceRoot).length)) {
      best = project;
    }
  }
  return best;
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const hosts = yield* RemoteHostService;
  const platform = yield* HostProcessPlatform;

  const resolve = (
    cwd: string,
  ): Effect.Effect<RemoteTerminalTarget | null, RemoteTerminalResolutionError> =>
    Effect.gen(function* () {
      // A project list that cannot be read means we cannot prove this directory is remote.
      // Treating that as "local" is the safe direction: the user gets their own machine,
      // which is what they would have got before the project was ever bound.
      const rows = yield* projects.listAll().pipe(Effect.orElseSucceed(() => []));
      const remote = findOwningProject(rows, cwd)?.remote;
      if (remote == null) {
        return null;
      }

      // From here the project IS bound, so every failure is fatal rather than a fallback.
      const target = yield* hosts.resolve(remote.host).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("remote.terminal.resolveFailed", { cwd, host: remote.host, cause }),
        ),
        Effect.mapError(
          (cause) =>
            new RemoteTerminalResolutionError({
              host: remote.host,
              cwd,
              reason: cause.message,
            }),
        ),
      );

      return {
        target,
        remotePath: remote.remotePath,
        loginShell: remote.capabilities?.loginShell ?? "sh",
        multiplexArgs: multiplexArgs({ target, platform }),
      } satisfies RemoteTerminalTarget;
    });

  return RemoteTerminalResolver.of({ resolve });
});

export const layer = Layer.effect(RemoteTerminalResolver, make);
