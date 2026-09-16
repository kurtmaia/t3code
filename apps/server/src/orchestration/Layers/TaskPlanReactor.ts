import { CommandId, TaskId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TaskPlanReactor, type TaskPlanReactorShape } from "../Services/TaskPlanReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ProposedPlanEvent = Extract<OrchestrationEvent, { type: "thread.proposed-plan-upserted" }>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const processProposedPlan = Effect.fn("processProposedPlan")(function* (
    event: ProposedPlanEvent,
  ) {
    const planMarkdown = event.payload.proposedPlan.planMarkdown.trim();
    if (planMarkdown.length === 0) {
      return;
    }

    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    const taskId = thread?.taskId ?? null;
    if (taskId === null) {
      return;
    }

    const task = readModel.tasks.find((entry) => entry.id === taskId && entry.deletedAt === null);
    if (task === undefined) {
      return;
    }
    // Only fills an empty plan. A plan someone already wrote or accepted is
    // theirs; a later proposal is offered in the thread rather than swapped in
    // underneath them.
    if ((task.planMarkdown ?? "").trim().length > 0) {
      return;
    }

    const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    yield* orchestrationEngine.dispatch({
      type: "task.meta.update",
      commandId,
      taskId: TaskId.make(taskId),
      planMarkdown,
    });
    yield* Effect.logInfo("promoted a proposed plan onto its task", {
      taskId,
      threadId: event.payload.threadId,
    });
  });

  const processSafely = (event: ProposedPlanEvent) =>
    processProposedPlan(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        // Promotion is a convenience on top of planning; failing it must never
        // disturb the thread that produced the plan.
        return Effect.logWarning("task plan reactor failed to process event", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processSafely);

  const start: TaskPlanReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.proposed-plan-upserted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return { start, drain: worker.drain } satisfies TaskPlanReactorShape;
});

export const TaskPlanReactorLive = Layer.effect(TaskPlanReactor, make);
