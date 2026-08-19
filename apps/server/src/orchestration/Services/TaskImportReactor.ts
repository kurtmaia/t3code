/**
 * TaskImportReactor - imports tasks a project already carries on disk.
 *
 * Reacts to project.created and reads the project's committed task folder,
 * dispatching one task.create per file it has not imported before.
 *
 * @module TaskImportReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface TaskImportReactorShape {
  /** Start reacting to project.created domain events. Run inside a scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when the queue is empty and idle. For tests, in place of sleeps. */
  readonly drain: Effect.Effect<void>;
}

export class TaskImportReactor extends Context.Service<TaskImportReactor, TaskImportReactorShape>()(
  "t3/orchestration/Services/TaskImportReactor",
) {}
