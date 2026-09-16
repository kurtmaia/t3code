import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_tasks)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  // The workspace a task's threads share, and the plan they all start from.
  if (!has("branch")) {
    yield* sql`ALTER TABLE projection_tasks ADD COLUMN branch TEXT`;
  }
  if (!has("worktree_path")) {
    yield* sql`ALTER TABLE projection_tasks ADD COLUMN worktree_path TEXT`;
  }
  if (!has("plan_markdown")) {
    yield* sql`ALTER TABLE projection_tasks ADD COLUMN plan_markdown TEXT`;
  }
});
