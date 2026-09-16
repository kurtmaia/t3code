import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const PARENT_THREAD_ID = ThreadId.make("thread-parent");

const SOURCE_QUOTE = {
  messageId: MessageId.make("message-1"),
  text: "the quoted passage",
} as const;

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: PARENT_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Parent thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(threads: ReadonlyArray<OrchestrationThread> = []): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [PROJECT_ID, OTHER_PROJECT_ID].map((id) => ({
      id,
      title: `Project ${id}`,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      faviconPath: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    })),
    threads,
    tasks: [],
    updatedAt: NOW,
  };
}

function makeSubThreadCreate(overrides: Record<string, unknown> = {}) {
  return {
    type: "thread.create",
    commandId: CommandId.make("cmd-subthread"),
    threadId: ThreadId.make("thread-sub"),
    projectId: PROJECT_ID,
    parentThreadId: PARENT_THREAD_ID,
    sourceQuote: SOURCE_QUOTE,
    title: "Re: the quoted passage",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    ...overrides,
  } as const;
}

it.layer(NodeServices.layer)("sub-thread decider", (it) => {
  it.effect("creates a sub-thread carrying its parent and quote", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: makeSubThreadCreate(),
        readModel: makeReadModel([makeThread()]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.parentThreadId).toBe(PARENT_THREAD_ID);
        expect(events[0].payload.sourceQuote).toEqual(SOURCE_QUOTE);
        expect(events[0].payload.interactionMode).toBe("plan");
      }
    }),
  );

  it.effect("keeps plain thread creation top-level", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: makeSubThreadCreate({ parentThreadId: undefined, sourceQuote: undefined }),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.parentThreadId).toBe(null);
        expect(events[0].payload.sourceQuote).toBe(null);
      } else {
        expect.unreachable("expected thread.created");
      }
    }),
  );

  it.effect("refuses a parent that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: makeSubThreadCreate(),
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses a parent in a different project", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: makeSubThreadCreate(),
        readModel: makeReadModel([makeThread({ projectId: OTHER_PROJECT_ID })]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("different project");
    }),
  );

  it.effect("refuses a sub-thread of a sub-thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: makeSubThreadCreate(),
        readModel: makeReadModel([
          makeThread({ parentThreadId: ThreadId.make("thread-grandparent") }),
        ]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("cannot parent another");
    }),
  );

  it.effect("refuses a quote without a parent", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: makeSubThreadCreate({ parentThreadId: undefined }),
        readModel: makeReadModel([makeThread()]),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("requires a parent thread");
    }),
  );
});
