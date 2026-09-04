import { CommandId, EventId, ProjectId, TaskId, type OrchestrationEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const TASK_ID = TaskId.make("task-1");

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
  readonly occurredAt?: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "task",
    aggregateId: TASK_ID,
    occurredAt: input.occurredAt ?? NOW,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const createdEvent = makeEvent({
  sequence: 1,
  type: "task.created",
  payload: {
    taskId: TASK_ID,
    projectId: ProjectId.make("project-1"),
    title: "Ship the board",
    status: "pending",
    priority: "P2",
    body: "Goal: ship it",
    labels: ["board"],
    orderKey: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

it.effect("projects a created task onto the board", () =>
  Effect.gen(function* () {
    const model = yield* projectEvent(createEmptyReadModel(NOW), createdEvent);
    expect(model.tasks).toHaveLength(1);
    expect(model.tasks[0]?.status).toBe("pending");
    expect(model.tasks[0]?.body).toBe("Goal: ship it");
    expect(model.tasks[0]?.labels).toEqual(["board"]);
    expect(model.tasks[0]?.deletedAt).toBeNull();
  }),
);

it.effect("applies a status change without touching other fields", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdEvent);
    const moved = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "task.status-changed",
        payload: {
          taskId: TASK_ID,
          status: "running",
          previousStatus: "pending",
          updatedAt: LATER,
        },
        occurredAt: LATER,
      }),
    );
    expect(moved.tasks[0]?.status).toBe("running");
    expect(moved.tasks[0]?.title).toBe("Ship the board");
    expect(moved.tasks[0]?.body).toBe("Goal: ship it");
    expect(moved.tasks[0]?.updatedAt).toBe(LATER);
  }),
);

it.effect("leaves absent meta fields alone", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdEvent);
    const renamed = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "task.meta-updated",
        payload: { taskId: TASK_ID, title: "Renamed", updatedAt: LATER },
        occurredAt: LATER,
      }),
    );
    expect(renamed.tasks[0]?.title).toBe("Renamed");
    // A rename must never blank the prose a human wrote.
    expect(renamed.tasks[0]?.body).toBe("Goal: ship it");
    expect(renamed.tasks[0]?.labels).toEqual(["board"]);
  }),
);

it.effect("projects a combined tower reconciliation in one event", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdEvent);
    const reconciled = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "task.import-reconciled",
        payload: {
          taskId: TASK_ID,
          title: "Tower title",
          status: "review",
          priority: "P1",
          body: "Tower body",
          labels: ["tower"],
          orderKey: "000004",
          updatedAt: LATER,
        },
        occurredAt: LATER,
      }),
    );
    expect(reconciled.tasks[0]).toMatchObject({
      title: "Tower title",
      status: "review",
      priority: "P1",
      body: "Tower body",
      labels: ["tower"],
      orderKey: "000004",
      updatedAt: LATER,
    });
  }),
);

it.effect("records a reorder key", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdEvent);
    const reordered = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "task.reordered",
        payload: { taskId: TASK_ID, orderKey: "a1", updatedAt: LATER },
        occurredAt: LATER,
      }),
    );
    expect(reordered.tasks[0]?.orderKey).toBe("a1");
  }),
);

it.effect("tombstones a deleted task rather than dropping the row", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdEvent);
    const deleted = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "task.deleted",
        payload: { taskId: TASK_ID, deletedAt: LATER },
        occurredAt: LATER,
      }),
    );
    expect(deleted.tasks).toHaveLength(1);
    expect(deleted.tasks[0]?.deletedAt).toBe(LATER);
  }),
);

it.effect("ignores events for a task it has never seen", () =>
  Effect.gen(function* () {
    const model = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeEvent({
        sequence: 1,
        type: "task.status-changed",
        payload: {
          taskId: TASK_ID,
          status: "running",
          previousStatus: "pending",
          updatedAt: NOW,
        },
      }),
    );
    expect(model.tasks).toHaveLength(0);
  }),
);
