import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { importTasksForProject } from "../orchestration/Layers/TaskImportReactor.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Shared plumbing for CLI commands that mutate orchestration state.
 *
 * The load-bearing part is execution mode. When a server is already running it
 * owns the database, so the CLI dispatches through its HTTP API; only when no
 * server answers does the CLI open SQLite itself. Opening a database a running
 * server holds is how you corrupt someone's work.
 */
export type CliCommandExecutionMode = "live" | "offline";

/**
 * Commands a CLI may dispatch: they must be valid both over the HTTP API and
 * straight into the engine. The two unions differ (turn starts are normalized
 * server-side), so the intersection is the honest bound.
 */
export type CliDispatchableCommand = ClientOrchestrationCommand & OrchestrationCommand;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class CliCommandIdGenerationError extends Schema.TaggedErrorClass<CliCommandIdGenerationError>()(
  "CliCommandIdGenerationError",
  {
    operation: Schema.Literal("generateCliCommandId"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a command identifier.";
  }
}

export class CliLiveServerDeclaredResponseError extends Schema.TaggedErrorClass<CliLiveServerDeclaredResponseError>()(
  "CliLiveServerDeclaredResponseError",
  {
    operation: Schema.Literal("callLiveServer"),
    code: Schema.String,
    traceId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.traceId === undefined
      ? `Server request failed (${this.code}).`
      : `Server request failed (${this.code}, trace ${this.traceId}).`;
  }
}

export class CliLiveServerUndeclaredStatusError extends Schema.TaggedErrorClass<CliLiveServerUndeclaredStatusError>()(
  "CliLiveServerUndeclaredStatusError",
  {
    operation: Schema.Literal("callLiveServer"),
    status: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed with status ${this.status}.`;
  }
}

export class CliLiveServerRequestError extends Schema.TaggedErrorClass<CliLiveServerRequestError>()(
  "CliLiveServerRequestError",
  {
    operation: Schema.Literal("callLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    // Deliberately not derived from the cause: it can carry credentials.
    return "Failed to call the running server.";
  }
}

export function cliCommandErrorFromLiveServerRequest(
  cause: unknown,
):
  | CliLiveServerDeclaredResponseError
  | CliLiveServerUndeclaredStatusError
  | CliLiveServerRequestError {
  if (isEnvironmentHttpCommonError(cause)) {
    return new CliLiveServerDeclaredResponseError({
      operation: "callLiveServer",
      code: cause.code,
      traceId: cause.traceId,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new CliLiveServerUndeclaredStatusError({
      operation: "callLiveServer",
      status: cause.response.status,
      cause,
    });
  }

  return new CliLiveServerRequestError({ operation: "callLiveServer", cause });
}

export const cliCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new CliCommandIdGenerationError({
        operation: "generateCliCommandId",
        cause,
      }),
  ),
);

const CliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1);

const withCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  label: string,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(CLI_LIVE_SERVER_TIMEOUT));

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

export const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(withCliLiveServerTimeout, Effect.mapError(cliCommandErrorFromLiveServerRequest));

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: CliDispatchableCommand,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(withCliLiveServerTimeout, Effect.mapError(cliCommandErrorFromLiveServerRequest));

const tryResolveLiveExecutionMode = Effect.fn("tryResolveLiveExecutionMode")(function* (
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  config: ServerConfig.ServerConfig["Service"],
  label: string,
) {
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return Option.none<{ readonly origin: string }>();
  }

  const attempted = yield* Effect.result(
    withCliSessionToken(environmentAuth, label, (token) =>
      fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
        Effect.as({ origin: runtimeState.value.origin }),
      ),
    ),
  );
  if (attempted._tag === "Success") {
    return Option.some(attempted.success);
  }

  yield* Effect.logDebug("Failed to connect to the persisted CLI server.", {
    origin: runtimeState.value.origin,
    cause: attempted.failure,
  });
  yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
  return Option.none<{ readonly origin: string }>();
});

export type CliMutationDispatch<Command extends CliDispatchableCommand> = (
  command: Command,
) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;

export interface CliMutationContext<Command extends CliDispatchableCommand> {
  readonly snapshot: OrchestrationReadModel;
  readonly dispatch: CliMutationDispatch<Command>;
  readonly mode: CliCommandExecutionMode;
}

/**
 * Resolves execution mode, hands the caller a snapshot plus a dispatcher bound
 * to that mode, and prints whatever string the caller returns.
 */
export const runOrchestrationCliMutation = <Command extends CliDispatchableCommand>(
  label: string,
  flags: CliAuthLocationFlags,
  run: (
    context: CliMutationContext<Command>,
  ) => Effect.Effect<
    string,
    Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = config.logLevel;

    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const liveMode = yield* tryResolveLiveExecutionMode(environmentAuth, config, label);

      if (Option.isSome(liveMode)) {
        return yield* withCliSessionToken(environmentAuth, label, (token) =>
          Effect.gen(function* () {
            const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
            const output = yield* run({
              snapshot,
              dispatch: (command) =>
                dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
              mode: "live",
            });
            yield* Console.log(output);
          }),
        );
      }

      const offlineRuntimeLayer = CliRuntimeLive.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      );

      return yield* Effect.gen(function* () {
        const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const crypto = yield* Crypto.Crypto;
        // The command read model carries projects and tasks without hydrating
        // every thread body in the database.
        const snapshot = yield* projectionSnapshotQuery.getCommandReadModel();
        const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
        const output = yield* run({
          snapshot,
          dispatch: (command) =>
            orchestrationEngine.dispatch(command).pipe(
              // Reactors only run inside a server. With none running, project
              // creation would otherwise skip the on-disk task import that the
              // same action performs through the app.
              Effect.tap(() =>
                command.type === "project.create"
                  ? importTasksForProject({
                      projectId: command.projectId,
                      workspaceRoot: command.workspaceRoot,
                    }).pipe(
                      Effect.provideService(
                        OrchestrationEngine.OrchestrationEngineService,
                        orchestrationEngine,
                      ),
                      Effect.provideService(
                        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
                        projectionSnapshotQuery,
                      ),
                      Effect.provideService(Crypto.Crypto, crypto),
                      // Import is a convenience: a project must still be added
                      // even when its task folder cannot be read.
                      Effect.ignore({ log: true }),
                    )
                  : Effect.void,
              ),
            ),
          mode: "offline",
        });
        yield* Console.log(output);
      }).pipe(Effect.provide(offlineRuntimeLayer));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });
