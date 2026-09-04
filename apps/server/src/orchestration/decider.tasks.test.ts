import {
  CommandId,
  ProjectId,
  TASK_STATUS_TRANSITIONS,
  TaskId,
  type OrchestrationReadModel,
  type OrchestrationTask,
  type TaskStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const TASK_ID = TaskId.make("task-1");

function makeTask(overrides: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    title: "Ship the board",
    status: "pending",
    priority: "P2",
    body: "",
    labels: [],
    orderKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeReadModel(tasks: ReadonlyArray<OrchestrationTask> = []): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        faviconPath: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [],
    tasks,
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("task decider", (it) => {
  it.effect("creates a task in pending with the default priority", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "task.create",
          commandId: CommandId.make("cmd-create"),
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          title: "Ship the board",
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("task.created");
      if (events[0]?.type === "task.created") {
        expect(events[0].aggregateKind).toBe("task");
        expect(events[0].aggregateId).toBe(TASK_ID);
        expect(events[0].payload.status).toBe("pending");
        expect(events[0].payload.priority).toBe("P2");
        expect(events[0].payload.orderKey).toBe(null);
      }
    }),
  );

  it.effect("refuses a task on a project that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "task.create",
          commandId: CommandId.make("cmd-create-orphan"),
          taskId: TASK_ID,
          projectId: ProjectId.make("project-missing"),
          title: "Orphan",
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses to create the same task twice", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "task.create",
          commandId: CommandId.make("cmd-create-dup"),
          taskId: TASK_ID,
          projectId: PROJECT_ID,
          title: "Duplicate",
          createdAt: NOW,
        },
        readModel: makeReadModel([makeTask()]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("records a legal status move with the status it came from", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "task.status.set",
          commandId: CommandId.make("cmd-status"),
          taskId: TASK_ID,
          status: "running",
        },
        readModel: makeReadModel([makeTask({ status: "pending" })]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "task.status-changed") {
        expect(events[0].payload.previousStatus).toBe("pending");
        expect(events[0].payload.status).toBe("running");
      } else {
        expect.unreachable("expected task.status-changed");
      }
    }),
  );

  it.effect("refuses a move the lifecycle does not model", () =>
    Effect.gen(function* () {
      // pending -> review would let work arrive in review having never run.
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "task.status.set",
          commandId: CommandId.make("cmd-status-illegal"),
          taskId: TASK_ID,
          status: "review",
        },
        readModel: makeReadModel([makeTask({ status: "pending" })]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("re-emits a same-status set as a projection no-op", () =>
    Effect.gen(function* () {
      // The engine requires an event per command, so a redundant drop must
      // carry the task's existing updatedAt rather than bump the clock.
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "task.status.set",
          commandId: CommandId.make("cmd-status-noop"),
          taskId: TASK_ID,
          status: "pending",
        },
        readModel: makeReadModel([makeTask({ status: "pending", updatedAt: NOW })]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "task.status-changed") {
        expect(events[0].payload.updatedAt).toBe(NOW);
        expect(events[0].payload.previousStatus).toBe("pending");
      } else {
        expect.unreachable("expected task.status-changed");
      }
    }),
  );

  it.effect("allows reopening a done task", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "task.status.set",
          commandId: CommandId.make("cmd-reopen"),
          taskId: TASK_ID,
          status: "pending",
        },
        readModel: makeReadModel([makeTask({ status: "done" })]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("task.status-changed");
    }),
  );

  it.effect("leaves absent meta fields unchanged", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "task.meta.update",
          commandId: CommandId.make("cmd-meta"),
          taskId: TASK_ID,
          title: "Renamed",
        },
        readModel: makeReadModel([makeTask({ body: "Goal: do the thing" })]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      if (events[0]?.type === "task.meta-updated") {
        expect(events[0].payload.title).toBe("Renamed");
        // An absent body must not reach the projector as a clear.
        expect(events[0].payload.body).toBeUndefined();
        expect(events[0].payload.labels).toBeUndefined();
      } else {
        expect.unreachable("expected task.meta-updated");
      }
    }),
  );

  it.effect("reconciles a tower task across lifecycle boundaries", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "task.import.reconcile",
          commandId: CommandId.make("cmd-import-reconcile"),
          taskId: TASK_ID,
          status: "review",
          title: "From tower",
        },
        readModel: makeReadModel([makeTask({ source: "tower" })]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("task.import-reconciled");
      if (events[0]?.type === "task.import-reconciled") {
        expect(events[0].payload.status).toBe("review");
        expect(events[0].payload.title).toBe("From tower");
      }
    }),
  );

  it.effect("refuses to reconcile a non-tower task", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "task.import.reconcile",
          commandId: CommandId.make("cmd-import-local"),
          taskId: TASK_ID,
          title: "Not allowed",
        },
        readModel: makeReadModel([makeTask()]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("re-emits a reorder that would not move the task", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "task.reorder",
          commandId: CommandId.make("cmd-reorder-noop"),
          taskId: TASK_ID,
          orderKey: "a0",
        },
        readModel: makeReadModel([makeTask({ orderKey: "a0", updatedAt: NOW })]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "task.reordered") {
        expect(events[0].payload.updatedAt).toBe(NOW);
      } else {
        expect.unreachable("expected task.reordered");
      }
    }),
  );

  it.effect("refuses commands against a deleted task", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "task.meta.update",
          commandId: CommandId.make("cmd-meta-deleted"),
          taskId: TASK_ID,
          title: "Too late",
        },
        readModel: makeReadModel([makeTask({ deletedAt: NOW })]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});

// A column nothing can move into is dead UI. Asserting on the exported table
// keeps this a pure data check, and catches a transition edited into a dead end.
it("leaves no task status unreachable", () => {
  const statuses = Object.keys(TASK_STATUS_TRANSITIONS) as ReadonlyArray<TaskStatus>;
  for (const status of statuses) {
    if (status === "pending") continue; // the entry point, reached by creation
    const reachable = statuses.some(
      (from) =>
        from !== status &&
        (TASK_STATUS_TRANSITIONS[from] as ReadonlyArray<TaskStatus>).includes(status),
    );
    expect(reachable, `no status reaches '${status}'`).toBe(true);
  }
});

it("never lists a status as its own successor", () => {
  // Same-status moves are handled as projection no-ops, not transitions.
  for (const [from, targets] of Object.entries(TASK_STATUS_TRANSITIONS)) {
    expect(targets as ReadonlyArray<string>).not.toContain(from);
  }
});
