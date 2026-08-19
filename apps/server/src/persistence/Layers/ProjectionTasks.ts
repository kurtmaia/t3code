import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionTaskInput,
  GetProjectionTaskInput,
  ListProjectionTasksByProjectInput,
  ProjectionTask,
  ProjectionTaskRepository,
  type ProjectionTaskRepositoryShape,
} from "../Services/ProjectionTasks.ts";

const ProjectionTaskDbRow = ProjectionTask.mapFields(
  Struct.assign({
    labels: Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString)),
  }),
);
type ProjectionTaskDbRow = typeof ProjectionTaskDbRow.Type;

const makeProjectionTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTaskRow = SqlSchema.void({
    Request: ProjectionTask,
    execute: (row) =>
      sql`
        INSERT INTO projection_tasks (
          task_id,
          project_id,
          title,
          status,
          priority,
          body,
          labels_json,
          order_key,
          source,
          external_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.taskId},
          ${row.projectId},
          ${row.title},
          ${row.status},
          ${row.priority},
          ${row.body},
          ${JSON.stringify(row.labels)},
          ${row.orderKey},
          ${row.source},
          ${row.externalId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          status = excluded.status,
          priority = excluded.priority,
          body = excluded.body,
          labels_json = excluded.labels_json,
          order_key = excluded.order_key,
          source = excluded.source,
          external_id = excluded.external_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionTaskRow = SqlSchema.findOneOption({
    Request: GetProjectionTaskInput,
    Result: ProjectionTaskDbRow,
    execute: ({ taskId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          project_id AS "projectId",
          title,
          status,
          priority,
          body,
          labels_json AS "labels",
          order_key AS "orderKey",
          source,
          external_id AS "externalId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_tasks
        WHERE task_id = ${taskId}
      `,
  });

  const listProjectionTaskRowsByProject = SqlSchema.findAll({
    Request: ListProjectionTasksByProjectInput,
    Result: ProjectionTaskDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          project_id AS "projectId",
          title,
          status,
          priority,
          body,
          labels_json AS "labels",
          order_key AS "orderKey",
          source,
          external_id AS "externalId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_tasks
        WHERE project_id = ${projectId}
        -- Keyless rows keep creation order, so a task never jumps its column
        -- just because a neighbour was dragged once.
        ORDER BY order_key IS NULL, order_key ASC, created_at ASC, task_id ASC
      `,
  });

  const deleteProjectionTaskRow = SqlSchema.void({
    Request: DeleteProjectionTaskInput,
    execute: ({ taskId }) =>
      sql`
        DELETE FROM projection_tasks
        WHERE task_id = ${taskId}
      `,
  });

  const upsert: ProjectionTaskRepositoryShape["upsert"] = (row) =>
    upsertProjectionTaskRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.upsert:query")),
    );

  const getById: ProjectionTaskRepositoryShape["getById"] = (input) =>
    getProjectionTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.getById:query")),
    );

  const listByProjectId: ProjectionTaskRepositoryShape["listByProjectId"] = (input) =>
    listProjectionTaskRowsByProject(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionTaskRepositoryShape["deleteById"] = (input) =>
    deleteProjectionTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionTaskRepositoryShape;
});

export const ProjectionTaskRepositoryLive = Layer.effect(
  ProjectionTaskRepository,
  makeProjectionTaskRepository,
);
