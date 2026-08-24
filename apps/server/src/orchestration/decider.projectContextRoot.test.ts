import { CommandId, EventId, ProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-context-root");

const seedProjectCreated = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`evt-project-context-root-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make(`cmd-project-context-root-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-project-context-root-${sequence}`),
  metadata: {},
  payload: {
    projectId,
    title: "Model",
    workspaceRoot: "/work/freight/nam-freight-model",
    defaultModelSelection: null,
    contextRoot: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

const firstEvent = (result: unknown): OrchestrationEvent =>
  (Array.isArray(result) ? result[0] : result) as OrchestrationEvent;

it.layer(NodeServices.layer)("decider project contextRoot", (it) => {
  it.effect("creates a project under a context root and carries it into the read model", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-context-root-create"),
          projectId,
          title: "Model",
          workspaceRoot: "/work/freight/nam-freight-model",
          contextRoot: "/work/freight",
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });

      const event = firstEvent(result);
      expect(event.type).toBe("project.created");
      expect((event.payload as { contextRoot?: unknown }).contextRoot).toBe("/work/freight");

      const readModel = yield* projectEvent(createEmptyReadModel(now), { ...event, sequence: 1 });
      expect(readModel.projects[0]?.contextRoot).toBe("/work/freight");
    }),
  );

  it.effect(
    "accepts the folder that stands for the group: context root equal to workspace root",
    () =>
      Effect.gen(function* () {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("cmd-context-root-self"),
            projectId,
            title: "Freight",
            workspaceRoot: "/work/freight/",
            contextRoot: "/work/freight",
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        });
        expect(firstEvent(result).type).toBe("project.created");
      }),
  );

  it.effect("rejects a context root that does not contain the workspace root", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("cmd-context-root-outside"),
            projectId,
            title: "Model",
            workspaceRoot: "/work/freight/nam-freight-model",
            contextRoot: "/work/pricing",
            createdAt: now,
          },
          readModel: createEmptyReadModel(now),
        }),
      );
      expect(failure._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(failure)).toContain("must contain workspace root");
    }),
  );

  it.effect("leaves the field out of the event when unset, sets it, then clears it on null", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated(1));
      expect(readModel.projects[0]?.contextRoot).toBeNull();

      const unrelated = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-context-root-title"),
            projectId,
            title: "Renamed",
          },
          readModel,
        }),
      );
      expect("contextRoot" in (unrelated.payload as object)).toBe(false);

      const set = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-context-root-set"),
            projectId,
            contextRoot: "/work/freight",
          },
          readModel,
        }),
      );
      const afterSet = yield* projectEvent(readModel, { ...set, sequence: 2 });
      expect(afterSet.projects[0]?.contextRoot).toBe("/work/freight");

      const clear = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-context-root-clear"),
            projectId,
            contextRoot: null,
          },
          readModel: afterSet,
        }),
      );
      const afterClear = yield* projectEvent(afterSet, { ...clear, sequence: 3 });
      expect(afterClear.projects[0]?.contextRoot).toBeNull();
    }),
  );

  it.effect("refuses to move the workspace root out from under its context root", () =>
    Effect.gen(function* () {
      const seeded = yield* projectEvent(createEmptyReadModel(now), seedProjectCreated(1));
      const set = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-context-root-set"),
            projectId,
            contextRoot: "/work/freight",
          },
          readModel: seeded,
        }),
      );
      const readModel = yield* projectEvent(seeded, { ...set, sequence: 2 });

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-context-root-move"),
            projectId,
            workspaceRoot: "/work/pricing/nam-pricing-api",
          },
          readModel,
        }),
      );
      expect(failure._tag).toBe("OrchestrationCommandInvariantError");

      // Moving both together is fine when the new pair still nests.
      const moved = firstEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-context-root-move-both"),
            projectId,
            workspaceRoot: "/work/pricing/nam-pricing-api",
            contextRoot: "/work/pricing",
          },
          readModel,
        }),
      );
      expect(moved.type).toBe("project.meta-updated");
    }),
  );
});
