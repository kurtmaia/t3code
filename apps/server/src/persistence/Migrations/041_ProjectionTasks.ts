import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      body TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      order_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  // The board reads one project's column at a time, ordered by the manual key
  // with creation order as the tiebreak for keyless rows.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_project_status_order
    ON projection_tasks(project_id, status, order_key, created_at)
  `;
});
