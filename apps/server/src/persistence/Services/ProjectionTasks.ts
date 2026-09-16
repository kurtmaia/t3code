import {
  IsoDateTime,
  ProjectId,
  TaskId,
  TaskPriority,
  TaskSource,
  TaskStatus,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTask = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
  title: Schema.String,
  status: TaskStatus,
  priority: TaskPriority,
  body: Schema.String,
  labels: Schema.Array(TrimmedNonEmptyString),
  orderKey: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  planMarkdown: Schema.NullOr(Schema.String),
  source: Schema.NullOr(TaskSource),
  externalId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTask = typeof ProjectionTask.Type;

export const GetProjectionTaskInput = Schema.Struct({
  taskId: TaskId,
});
export type GetProjectionTaskInput = typeof GetProjectionTaskInput.Type;

export const ListProjectionTasksByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionTasksByProjectInput = typeof ListProjectionTasksByProjectInput.Type;

export const DeleteProjectionTaskInput = Schema.Struct({
  taskId: TaskId,
});
export type DeleteProjectionTaskInput = typeof DeleteProjectionTaskInput.Type;

export interface ProjectionTaskRepositoryShape {
  /** Upserts by `taskId` and persists labels through JSON encoding. */
  readonly upsert: (task: ProjectionTask) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionTaskInput,
  ) => Effect.Effect<Option.Option<ProjectionTask>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectionTasksByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTask>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteProjectionTaskInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTaskRepository extends Context.Service<
  ProjectionTaskRepository,
  ProjectionTaskRepositoryShape
>()("t3/persistence/Services/ProjectionTasks/ProjectionTaskRepository") {}
