import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_tasks)
  `;

  if (!columns.some((column) => column.name === "source")) {
    yield* sql`ALTER TABLE projection_tasks ADD COLUMN source TEXT`;
  }
  if (!columns.some((column) => column.name === "external_id")) {
    yield* sql`ALTER TABLE projection_tasks ADD COLUMN external_id TEXT`;
  }

  // One imported task per source identity per project. Partial so tasks
  // authored in t3 (both columns null) are unconstrained.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_tasks_source_identity
    ON projection_tasks(project_id, source, external_id)
    WHERE source IS NOT NULL AND external_id IS NOT NULL
  `;
});
