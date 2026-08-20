/**
 * TaskPlanReactor - promotes a thread's proposed plan onto its task.
 *
 * A task's plan is written either by a human or by an agent running in plan
 * mode. When a thread that belongs to a task proposes a plan, this copies it
 * onto the task so every later thread starts from it.
 *
 * @module TaskPlanReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface TaskPlanReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when the queue is empty and idle. For tests, in place of sleeps. */
  readonly drain: Effect.Effect<void>;
}

export class TaskPlanReactor extends Context.Service<TaskPlanReactor, TaskPlanReactorShape>()(
  "t3/orchestration/Services/TaskPlanReactor",
) {}
