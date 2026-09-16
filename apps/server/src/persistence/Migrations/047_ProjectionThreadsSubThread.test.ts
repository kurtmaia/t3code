import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionThreadsSubThread", (it) => {
  it.effect("adds the nullable sub-thread columns to thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const parentThreadId = columns.find((column) => column.name === "parent_thread_id");
      const sourceQuote = columns.find((column) => column.name === "source_quote_json");

      assert.equal(parentThreadId?.name, "parent_thread_id");
      assert.equal(sourceQuote?.name, "source_quote_json");
      // Every thread that existed before this migration is a top-level thread.
      assert.equal(parentThreadId?.notnull, 0);
      assert.equal(sourceQuote?.notnull, 0);
    }),
  );

  it.effect("is a no-op when the columns are already present", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      assert.equal(columns.filter((column) => column.name === "parent_thread_id").length, 1);
      assert.equal(columns.filter((column) => column.name === "source_quote_json").length, 1);
    }),
  );
});
