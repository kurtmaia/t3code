import { CommandId, ProjectId, ProviderInstanceId, TaskId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { TaskPlanReactorLive } from "./TaskPlanReactor.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TaskPlanReactor } from "../Services/TaskPlanReactor.ts";
import { ServerConfig } from "../../config.ts";

const PROJECT_ID = ProjectId.make("project-tasks");
const TASK_ID = TaskId.make("task-1");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const engineLayer = it.layer(
  TaskPlanReactorLive.pipe(
    Layer.provideMerge(OrchestrationEngineLive),
    // provideMerge, not provide: the test reads the snapshot the engine writes.
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-tasks-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("task board round trip", (it) => {
  it.effect("creates a task through the engine and reads it back from the snapshot", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project"),
        projectId: PROJECT_ID,
        title: "Tasks Project",
        workspaceRoot: "/tmp/project-tasks",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.create",
        commandId: CommandId.make("cmd-task-create"),
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        title: "Ship the board",
        body: "Goal: ship it",
        labels: ["board"],
        createdAt: CREATED_AT,
      });

      // The projection row is the durable half: it must survive a rebuild.
      const rows = yield* sql<{
        readonly status: string;
        readonly priority: string;
        readonly labelsJson: string;
      }>`
        SELECT status, priority, labels_json AS "labelsJson"
        FROM projection_tasks
        WHERE task_id = ${TASK_ID}
      `;
      assert.deepEqual(rows, [{ status: "pending", priority: "P2", labelsJson: '["board"]' }]);

      // The snapshot is what a client actually renders.
      const snapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(snapshot.tasks.length, 1);
      assert.equal(snapshot.tasks[0]?.title, "Ship the board");
      assert.equal(snapshot.tasks[0]?.status, "pending");
      assert.deepEqual(snapshot.tasks[0]?.labels, ["board"]);
    }),
  );

  it.effect("moves a task across the board and rejects an illegal move", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-moves"),
        projectId: ProjectId.make("project-moves"),
        title: "Moves Project",
        workspaceRoot: "/tmp/project-moves",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.create",
        commandId: CommandId.make("cmd-task-moves"),
        taskId: TaskId.make("task-moves"),
        projectId: ProjectId.make("project-moves"),
        title: "Move me",
        createdAt: CREATED_AT,
      });

      yield* engine.dispatch({
        type: "task.status.set",
        commandId: CommandId.make("cmd-task-running"),
        taskId: TaskId.make("task-moves"),
        status: "running",
      });
      yield* engine.dispatch({
        type: "task.status.set",
        commandId: CommandId.make("cmd-task-review"),
        taskId: TaskId.make("task-moves"),
        status: "review",
      });

      const snapshot = yield* snapshotQuery.getSnapshot();
      const moved = snapshot.tasks.find((task) => task.id === TaskId.make("task-moves"));
      assert.equal(moved?.status, "review");

      // review -> planning is not a move the lifecycle models.
      const failure = yield* Effect.result(
        engine.dispatch({
          type: "task.status.set",
          commandId: CommandId.make("cmd-task-illegal"),
          taskId: TaskId.make("task-moves"),
          status: "planning",
        }),
      );
      assert.equal(failure._tag, "Failure");

      const afterFailure = yield* snapshotQuery.getSnapshot();
      const unchanged = afterFailure.tasks.find((task) => task.id === TaskId.make("task-moves"));
      assert.equal(unchanged?.status, "review");
    }),
  );

  it.effect("groups threads under a task and lets them be detached", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-group"),
        projectId: ProjectId.make("project-group"),
        title: "Group Project",
        workspaceRoot: "/tmp/project-group",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.create",
        commandId: CommandId.make("cmd-task-group"),
        taskId: TaskId.make("task-group"),
        projectId: ProjectId.make("project-group"),
        title: "Groups threads",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-group"),
        threadId: ThreadId.make("thread-group"),
        projectId: ProjectId.make("project-group"),
        taskId: TaskId.make("task-group"),
        title: "Work on the task",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: CREATED_AT,
      });

      const grouped = yield* snapshotQuery.getShellSnapshot();
      assert.equal(
        grouped.threads.find((thread) => thread.id === "thread-group")?.taskId,
        "task-group",
      );

      // Detaching is the way out: a thread grouped by mistake must not be
      // stuck there.
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-detach"),
        threadId: ThreadId.make("thread-group"),
        taskId: null,
      });

      const detached = yield* snapshotQuery.getShellSnapshot();
      assert.equal(
        detached.threads.find((thread) => thread.id === "thread-group")?.taskId ?? null,
        null,
      );
    }),
  );

  it.effect("carries the shared workspace and plan through the projection", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-plan"),
        projectId: ProjectId.make("project-plan"),
        title: "Plan Project",
        workspaceRoot: "/tmp/project-plan",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.create",
        commandId: CommandId.make("cmd-task-plan"),
        taskId: TaskId.make("task-plan"),
        projectId: ProjectId.make("project-plan"),
        title: "Has a plan",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.meta.update",
        commandId: CommandId.make("cmd-task-plan-set"),
        taskId: TaskId.make("task-plan"),
        planMarkdown: "1. Read the code\n2. Change it",
        branch: "task/has-a-plan",
        worktreePath: "/tmp/worktrees/has-a-plan",
      });

      const snapshot = yield* snapshotQuery.getCommandReadModel();
      const task = snapshot.tasks.find((entry) => entry.id === "task-plan");
      assert.equal(task?.planMarkdown, "1. Read the code\n2. Change it");
      assert.equal(task?.branch, "task/has-a-plan");
      assert.equal(task?.worktreePath, "/tmp/worktrees/has-a-plan");
      // An unrelated edit must not clear the plan.
      yield* engine.dispatch({
        type: "task.meta.update",
        commandId: CommandId.make("cmd-task-plan-rename"),
        taskId: TaskId.make("task-plan"),
        title: "Still has a plan",
      });
      const after = yield* snapshotQuery.getCommandReadModel();
      const renamed = after.tasks.find((entry) => entry.id === "task-plan");
      assert.equal(renamed?.title, "Still has a plan");
      assert.equal(renamed?.planMarkdown, "1. Read the code\n2. Change it");
    }),
  );

  it.effect("promotes a thread's proposed plan onto its task, but never over one that exists", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reactor = yield* TaskPlanReactor;
      yield* reactor.start();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-promote"),
        projectId: ProjectId.make("project-promote"),
        title: "Promote Project",
        workspaceRoot: "/tmp/project-promote",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.create",
        commandId: CommandId.make("cmd-task-promote"),
        taskId: TaskId.make("task-promote"),
        projectId: ProjectId.make("project-promote"),
        title: "Needs a plan",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-promote"),
        threadId: ThreadId.make("thread-promote"),
        projectId: ProjectId.make("project-promote"),
        taskId: TaskId.make("task-promote"),
        title: "Planning",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        createdAt: CREATED_AT,
      });

      yield* engine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make("cmd-plan-1"),
        threadId: ThreadId.make("thread-promote"),
        proposedPlan: {
          id: "plan-1",
          turnId: null,
          planMarkdown: "1. Read it\n2. Change it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
        createdAt: CREATED_AT,
      });
      yield* reactor.drain;

      const filled = (yield* snapshotQuery.getCommandReadModel()).tasks.find(
        (task) => task.id === "task-promote",
      );
      assert.equal(filled?.planMarkdown, "1. Read it\n2. Change it");

      // A second proposal must not overwrite the plan now in place.
      yield* engine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make("cmd-plan-2"),
        threadId: ThreadId.make("thread-promote"),
        proposedPlan: {
          id: "plan-2",
          turnId: null,
          planMarkdown: "A different approach entirely",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
        createdAt: CREATED_AT,
      });
      yield* reactor.drain;

      const unchanged = (yield* snapshotQuery.getCommandReadModel()).tasks.find(
        (task) => task.id === "task-promote",
      );
      assert.equal(unchanged?.planMarkdown, "1. Read it\n2. Change it");
    }),
  );

  it.effect("removes a project's tasks along with the project", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-cascade"),
        projectId: ProjectId.make("project-cascade"),
        title: "Cascade Project",
        workspaceRoot: "/tmp/project-cascade",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.create",
        commandId: CommandId.make("cmd-task-cascade"),
        taskId: TaskId.make("task-cascade"),
        projectId: ProjectId.make("project-cascade"),
        title: "Goes with the project",
        createdAt: CREATED_AT,
      });

      // Tasks must not block the delete the way threads do, and must not be
      // left behind rendering as cards belonging to nothing.
      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("cmd-project-cascade-delete"),
        projectId: ProjectId.make("project-cascade"),
      });

      const snapshot = yield* snapshotQuery.getCommandReadModel();
      const remaining = snapshot.tasks.filter(
        (task) => task.projectId === "project-cascade" && task.deletedAt === null,
      );
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("keeps a deleted task out of the decider's view", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-del"),
        projectId: ProjectId.make("project-del"),
        title: "Delete Project",
        workspaceRoot: "/tmp/project-del",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.create",
        commandId: CommandId.make("cmd-task-del"),
        taskId: TaskId.make("task-del"),
        projectId: ProjectId.make("project-del"),
        title: "Delete me",
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "task.delete",
        commandId: CommandId.make("cmd-task-del-run"),
        taskId: TaskId.make("task-del"),
      });

      const failure = yield* Effect.result(
        engine.dispatch({
          type: "task.meta.update",
          commandId: CommandId.make("cmd-task-del-update"),
          taskId: TaskId.make("task-del"),
          title: "Too late",
        }),
      );
      assert.equal(failure._tag, "Failure");
    }),
  );
});
