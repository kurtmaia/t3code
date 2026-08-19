import type { EnvironmentId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  createTask,
  deleteTask,
  reorderTask,
  setTaskStatus,
  updateTaskMetadata,
  type CreateTaskInput,
  type DeleteTaskInput,
  type ReorderTaskInput,
  type SetTaskStatusInput,
  type UpdateTaskMetadataInput,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateTaskInput,
  DeleteTaskInput,
  ReorderTaskInput,
  SetTaskStatusInput,
  UpdateTaskMetadataInput,
} from "../operations/commands.ts";

export function createTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const taskScheduler = createAtomCommandScheduler();
  // Serialised per task: two status moves racing on one card would otherwise
  // land in whichever order the network chose.
  const taskConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: EnvironmentId; input: { taskId?: string } }) =>
      JSON.stringify([environmentId, input.taskId ?? "create"]),
  };

  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:create",
      execute: (input: CreateTaskInput) => createTask(input),
      scheduler: taskScheduler,
      concurrency: taskConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:update",
      execute: (input: UpdateTaskMetadataInput) => updateTaskMetadata(input),
      scheduler: taskScheduler,
      concurrency: taskConcurrency,
    }),
    setStatus: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:set-status",
      execute: (input: SetTaskStatusInput) => setTaskStatus(input),
      scheduler: taskScheduler,
      concurrency: taskConcurrency,
    }),
    reorder: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:reorder",
      execute: (input: ReorderTaskInput) => reorderTask(input),
      scheduler: taskScheduler,
      concurrency: taskConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:delete",
      execute: (input: DeleteTaskInput) => deleteTask(input),
      scheduler: taskScheduler,
      concurrency: taskConcurrency,
    }),
  };
}
