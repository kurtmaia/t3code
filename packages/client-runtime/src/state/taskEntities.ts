import type { EnvironmentId, OrchestrationShellSnapshot, TaskId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentCatalogState } from "./connections.ts";
import { scopeTask, type EnvironmentTask } from "./models.ts";

const EMPTY_TASKS: ReadonlyArray<EnvironmentTask> = Object.freeze([]);

function tasksEqual(
  left: ReadonlyArray<EnvironmentTask>,
  right: ReadonlyArray<EnvironmentTask>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Board state derived from the shell snapshot each environment already streams.
 * Tasks are small and few compared with threads, so the board reads the whole
 * list rather than paginating: a kanban that hides cards is a lying kanban.
 */
export function createEnvironmentTaskAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentTasksAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<EnvironmentTask> = EMPTY_TASKS;
    return Atom.make((get): ReadonlyArray<EnvironmentTask> => {
      const tasks = get(input.snapshotAtom(environmentId))?.tasks ?? [];
      if (tasks.length === 0) {
        previous = EMPTY_TASKS;
        return EMPTY_TASKS;
      }
      const next = tasks.map((task) => scopeTask(environmentId, task));
      // Identity is stable while the snapshot is, so a re-render of the board
      // does not rebuild every card.
      if (
        previous.length === next.length &&
        previous.every((task, index) => {
          const candidate = next[index];
          return (
            candidate !== undefined &&
            task.id === candidate.id &&
            task.updatedAt === candidate.updatedAt
          );
        })
      ) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-tasks:${environmentId}`));
  });

  let previousTasks: ReadonlyArray<EnvironmentTask> = EMPTY_TASKS;
  const tasksAtom = Atom.make((get): ReadonlyArray<EnvironmentTask> => {
    const next: EnvironmentTask[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      next.push(...get(environmentTasksAtom(environmentId)));
    }
    if (tasksEqual(previousTasks, next)) {
      return previousTasks;
    }
    previousTasks = next;
    return next;
  }).pipe(Atom.withLabel("environment-tasks"));

  const taskAtom = Atom.family((taskId: TaskId) =>
    Atom.make((get): EnvironmentTask | null => {
      return get(tasksAtom).find((task) => task.id === taskId) ?? null;
    }).pipe(Atom.withLabel(`environment-task:${taskId}`)),
  );

  return { environmentTasksAtom, tasksAtom, taskAtom };
}
