import { CommandId, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { TaskImportReactorLive } from "./TaskImportReactor.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TaskImportReactor } from "../Services/TaskImportReactor.ts";
import { ServerConfig } from "../../config.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

const taskFile = (input: {
  readonly title: string;
  readonly status: string;
  readonly priority?: string;
  readonly order?: number;
}) => `---
id: demo/001
title: '${input.title}'
status: ${input.status}
priority: ${input.priority ?? "P2"}
order: ${input.order ?? 0}
labels: []
isolation: null
---
## Goal
${input.title} body.
`;

const reactorLayer = it.layer(
  TaskImportReactorLive.pipe(
    Layer.provideMerge(OrchestrationEngineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-import-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const seedTowerProject = Effect.fn("seedTowerProject")(function* (files: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const tasksDir = path.join(root, ".tower", "tasks");
  yield* fileSystem.makeDirectory(tasksDir, { recursive: true });
  for (const [index, contents] of files.entries()) {
    const stem = `00${index + 1}-task-${index + 1}`;
    yield* fileSystem.writeFileString(path.join(tasksDir, `${stem}.md`), contents);
    // Tower keeps an append-only sidecar next to each task; the importer must
    // not mistake it for a task file.
    yield* fileSystem.writeFileString(
      path.join(tasksDir, `${stem}.events.ndjson`),
      '{"ts":"2026-01-01T00:00:00Z","type":"created"}\n',
    );
  }
  return root;
});

reactorLayer("task import reactor", (it) => {
  it.effect("imports a project's tower tasks when the project is created", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const reactor = yield* TaskImportReactor;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* reactor.start();

      const workspaceRoot = yield* seedTowerProject([
        taskFile({ title: "Ship the board", status: "pending", priority: "P1", order: 1 }),
        taskFile({ title: "Review the diff", status: "review", order: 0 }),
        taskFile({ title: "Waiting on a slot", status: "needs-app-slot" }),
      ]);

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project"),
        projectId: ProjectId.make("project-tower"),
        title: "Tower Project",
        workspaceRoot,
        createdAt: CREATED_AT,
      });
      yield* reactor.drain;

      const snapshot = yield* snapshotQuery.getCommandReadModel();
      const tasks = snapshot.tasks.filter((task) => task.projectId === "project-tower");
      assert.equal(tasks.length, 3, "the .events.ndjson sidecars must not import as tasks");

      const shipped = tasks.find((task) => task.title === "Ship the board");
      assert.equal(shipped?.source, "tower");
      assert.equal(shipped?.priority, "P1");
      assert.equal(shipped?.orderKey, "000001");
      assert.ok(shipped?.body.includes("Ship the board body."));

      // Status survives the import, so a task already in review does not
      // reappear as untouched work.
      assert.equal(tasks.find((task) => task.title === "Review the diff")?.status, "review");
      // Tower's capacity status has no t3 equivalent and lands in blocked.
      assert.equal(tasks.find((task) => task.title === "Waiting on a slot")?.status, "blocked");
    }),
  );

  it.effect("does not import the same task twice when a project is re-added", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const reactor = yield* TaskImportReactor;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* reactor.start();

      const workspaceRoot = yield* seedTowerProject([
        taskFile({ title: "Only once", status: "pending" }),
      ]);

      for (const [index, projectId] of ["project-a", "project-a"].entries()) {
        yield* Effect.result(
          engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`cmd-readd-${index}`),
            projectId: ProjectId.make(projectId),
            title: "Re-added",
            workspaceRoot,
            createdAt: CREATED_AT,
          }),
        );
        yield* reactor.drain;
      }

      const snapshot = yield* snapshotQuery.getCommandReadModel();
      const tasks = snapshot.tasks.filter((task) => task.projectId === "project-a");
      assert.equal(tasks.length, 1);
    }),
  );

  it.effect("leaves a project without a tower folder alone", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const reactor = yield* TaskImportReactor;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* reactor.start();

      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped();
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-plain"),
        projectId: ProjectId.make("project-plain"),
        title: "Plain",
        workspaceRoot,
        createdAt: CREATED_AT,
      });
      yield* reactor.drain;

      const snapshot = yield* snapshotQuery.getCommandReadModel();
      assert.equal(snapshot.tasks.filter((task) => task.projectId === "project-plain").length, 0);
    }),
  );
});
