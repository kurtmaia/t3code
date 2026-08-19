import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "task_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN task_id TEXT`;
  }

  // The task detail reads one task's threads at a time.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_task
    ON projection_threads(task_id, created_at)
    WHERE task_id IS NOT NULL
  `;
});
