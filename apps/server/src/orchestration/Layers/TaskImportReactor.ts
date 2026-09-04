import { CommandId, TaskId, type OrchestrationEvent, type ProjectId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import {
  TOWER_TASKS_RELATIVE_DIR,
  importedExternalIds,
  parseTowerTaskFile,
  towerDraftDiffers,
  type TowerTaskDraft,
} from "../../tasks/TowerTaskImport.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TaskImportReactor, type TaskImportReactorShape } from "../Services/TaskImportReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ProjectCreatedEvent = Extract<OrchestrationEvent, { type: "project.created" }>;

// A task folder is small by design (tens of files). This bound exists so a
// directory that is not what we think it is cannot turn project creation into
// an unbounded import.
const MAX_IMPORTED_TASKS_PER_PROJECT = 500;

const readTowerDraftsFor = Effect.fn("readTowerDraftsFor")(function* (workspaceRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tasksDir = path.join(workspaceRoot, TOWER_TASKS_RELATIVE_DIR);
  // The common case is a project with no task folder, so absence is a quiet
  // "nothing to do" rather than anything worth logging.
  const exists = yield* fileSystem.exists(tasksDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return [] as ReadonlyArray<TowerTaskDraft>;
  }

  const entries = yield* fileSystem.readDirectory(tasksDir).pipe(Effect.orElseSucceed(() => []));
  const taskFiles = entries
    .filter((entry) => entry.endsWith(".md"))
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, MAX_IMPORTED_TASKS_PER_PROJECT);

  const drafts: TowerTaskDraft[] = [];
  for (const entry of taskFiles) {
    const contents = yield* fileSystem
      .readFileString(path.join(tasksDir, entry))
      .pipe(Effect.orElseSucceed(() => null));
    if (contents === null) continue;
    const draft = parseTowerTaskFile({ externalId: entry.replace(/\.md$/, ""), contents });
    if (draft !== null) drafts.push(draft);
  }
  return drafts as ReadonlyArray<TowerTaskDraft>;
});

const readTowerTasksMtimeFor = Effect.fn("readTowerTasksMtimeFor")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tasksDir = path.join(workspaceRoot, TOWER_TASKS_RELATIVE_DIR);
  const exists = yield* fileSystem.exists(tasksDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return null;
  const entries = yield* fileSystem.readDirectory(tasksDir).pipe(Effect.orElseSucceed(() => []));
  const mtimes = yield* Effect.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) =>
        fileSystem.stat(path.join(tasksDir, entry)).pipe(
          Effect.map((info) =>
            Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
          ),
          Effect.orElseSucceed(() => 0),
        ),
      ),
  );
  const dirMtime = yield* fileSystem.stat(tasksDir).pipe(
    Effect.map((info) =>
      Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
    ),
    Effect.orElseSucceed(() => 0),
  );
  return Math.max(dirMtime, ...mtimes);
});

/**
 * Syncs a project's on-disk tasks. New files are created and existing tower
 * mirrors are reconciled; files missing from disk are intentionally retained.
 *
 * Exported because project creation happens on two paths — through the server
 * (where the reactor runs) and through the CLI with no server running — and a
 * task folder should be picked up either way.
 */
export const syncTasksForProject = Effect.fn("syncTasksForProject")(function* (input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);

  const drafts = yield* readTowerDraftsFor(input.workspaceRoot);
  if (drafts.length === 0) {
    return 0;
  }

  // Read what is already imported rather than assuming a fresh project: the
  // same workspace can be added, removed and added again.
  const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
  const alreadyImported = importedExternalIds(readModel.tasks, input.projectId);
  const pending = drafts.filter((draft) => !alreadyImported.has(draft.externalId));
  const existingByExternalId = new Map(
    readModel.tasks
      .filter(
        (task) =>
          task.projectId === input.projectId && task.source === "tower" && task.externalId !== null,
      )
      .map((task) => [task.externalId as string, task]),
  );

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  let imported = 0;
  for (const draft of pending) {
    const dispatched = yield* Effect.result(
      orchestrationEngine.dispatch({
        type: "task.create",
        commandId: CommandId.make(yield* newId),
        taskId: TaskId.make(yield* newId),
        projectId: input.projectId,
        title: draft.title,
        status: draft.status,
        priority: draft.priority,
        body: draft.body,
        labels: draft.labels,
        orderKey: draft.orderKey,
        source: "tower",
        externalId: draft.externalId,
        createdAt,
      }),
    );
    if (dispatched._tag === "Success") {
      imported += 1;
      continue;
    }
    // One unreadable task must not abandon the rest of the folder.
    yield* Effect.logDebug("task import skipped a tower task", {
      projectId: input.projectId,
      externalId: draft.externalId,
      cause: dispatched.failure,
    });
  }

  let reconciled = 0;
  for (const draft of drafts) {
    const task = existingByExternalId.get(draft.externalId);
    if (!task) continue;
    const patch = towerDraftDiffers(draft, task);
    if (patch === null) continue;
    const dispatched = yield* Effect.result(
      orchestrationEngine.dispatch({
        type: "task.import.reconcile",
        commandId: CommandId.make(yield* newId),
        taskId: task.id,
        ...patch,
      }),
    );
    if (dispatched._tag === "Success") {
      reconciled += 1;
    } else {
      yield* Effect.logDebug("task import reconciliation skipped a tower task", {
        projectId: input.projectId,
        externalId: draft.externalId,
        cause: dispatched.failure,
      });
    }
  }

  yield* Effect.logInfo("imported tower tasks for project", {
    projectId: input.projectId,
    imported,
    reconciled,
    skipped: drafts.length - imported - reconciled,
  });
  return imported + reconciled;
});

export const importTasksForProject = syncTasksForProject;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const lastSeenMtimes = yield* Ref.make(new Map<string, number | null>());

  const syncProject = (input: { readonly projectId: ProjectId; readonly workspaceRoot: string }) =>
    syncTasksForProject(input).pipe(
      Effect.provideService(OrchestrationEngineService, orchestrationEngine),
      Effect.provideService(ProjectionSnapshotQuery, projectionSnapshotQuery),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
    );

  const processProjectCreated = Effect.fn("processProjectCreated")(function* (
    event: ProjectCreatedEvent,
  ) {
    yield* syncProject({
      projectId: event.payload.projectId,
      workspaceRoot: event.payload.workspaceRoot,
    });
  });

  const processSafely = (event: ProjectCreatedEvent) =>
    processProjectCreated(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        // Import is a convenience layered on project creation; a failure here
        // must never make the project itself look broken.
        return Effect.logWarning("task import reactor failed to process event", {
          projectId: event.payload.projectId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processSafely);

  const scanProjects = Effect.gen(function* () {
    const snapshot = yield* projectionSnapshotQuery.getCommandReadModel();
    for (const project of snapshot.projects) {
      if (project.deletedAt !== null) continue;
      const mtime = yield* readTowerTasksMtimeFor(project.workspaceRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const previous = yield* Ref.get(lastSeenMtimes);
      if (previous.get(project.id) === mtime) continue;
      const synced = yield* syncProject({
        projectId: project.id,
        workspaceRoot: project.workspaceRoot,
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("task import reactor failed to scan project", {
            projectId: project.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      // Only a sync that landed retires this mtime. Recording it up front
      // makes a transient read or dispatch failure permanent: the next poll
      // sees an unchanged mtime and skips the project until tower writes again.
      if (synced) {
        yield* Ref.update(lastSeenMtimes, (seen) => new Map(seen).set(project.id, mtime));
      }
    }
  });

  const start: TaskImportReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "project.created") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
    yield* forkParked(
      scanProjects.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("task import reactor scan failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(
          Schedule.spaced(Duration.millis(config.towerTaskImportSyncIntervalMs ?? 30_000)),
        ),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies TaskImportReactorShape;
});

export const TaskImportReactorLive = Layer.effect(TaskImportReactor, make);
