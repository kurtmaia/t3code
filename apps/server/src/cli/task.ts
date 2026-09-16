import {
  CommandId,
  DEFAULT_TASK_PRIORITY,
  ProjectId,
  TASK_STATUS_TRANSITIONS,
  TaskId,
  TaskPriority,
  TaskStatus,
  canTransitionTask,
  type ClientOrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  cliCommandUuid,
  runOrchestrationCliMutation,
  type CliMutationContext,
} from "./orchestrationCli.ts";
import { projectLocationFlags } from "./config.ts";

const CLI_LABEL = "t3 task cli";

type TaskCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "task.create" | "task.meta.update" | "task.status.set" | "task.delete" }
>;

type TaskCliContext = CliMutationContext<TaskCliDispatchCommand>;

const isTaskStatus = Schema.is(TaskStatus);
const isTaskPriority = Schema.is(TaskPriority);

export class TaskProjectNotFoundError extends Schema.TaggedErrorClass<TaskProjectNotFoundError>()(
  "TaskProjectNotFoundError",
  {
    operation: Schema.Literal("resolveTaskProject"),
    identifier: Schema.String,
    activeProjectCount: Schema.Number,
  },
) {
  override get message(): string {
    return this.activeProjectCount === 0
      ? `No projects exist yet. Add one with 't3 project add <path>' before creating tasks.`
      : `No project matches '${this.identifier}'. Pass a project id or its workspace root.`;
  }
}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()(
  "TaskNotFoundError",
  {
    operation: Schema.Literal("resolveTask"),
    identifier: Schema.String,
  },
) {
  override get message(): string {
    return `No task matches '${this.identifier}'. Run 't3 task list' to see task ids.`;
  }
}

export class TaskAmbiguousIdentifierError extends Schema.TaggedErrorClass<TaskAmbiguousIdentifierError>()(
  "TaskAmbiguousIdentifierError",
  {
    operation: Schema.Literal("resolveTask"),
    identifier: Schema.String,
    matches: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `'${this.identifier}' matches ${this.matches.length} tasks: ${this.matches.join(", ")}. Use a full task id.`;
  }
}

export class TaskInvalidStatusError extends Schema.TaggedErrorClass<TaskInvalidStatusError>()(
  "TaskInvalidStatusError",
  {
    operation: Schema.Literal("parseTaskStatus"),
    status: Schema.String,
  },
) {
  override get message(): string {
    return `'${this.status}' is not a task status. Valid statuses: ${Object.keys(TASK_STATUS_TRANSITIONS).join(", ")}.`;
  }
}

export class TaskInvalidPriorityError extends Schema.TaggedErrorClass<TaskInvalidPriorityError>()(
  "TaskInvalidPriorityError",
  {
    operation: Schema.Literal("parseTaskPriority"),
    priority: Schema.String,
  },
) {
  override get message(): string {
    return `'${this.priority}' is not a task priority. Valid priorities: P0, P1, P2, P3.`;
  }
}

export class TaskIllegalTransitionError extends Schema.TaggedErrorClass<TaskIllegalTransitionError>()(
  "TaskIllegalTransitionError",
  {
    operation: Schema.Literal("moveTask"),
    taskId: Schema.String,
    from: TaskStatus,
    to: TaskStatus,
  },
) {
  override get message(): string {
    const allowed = TASK_STATUS_TRANSITIONS[this.from] as ReadonlyArray<string>;
    return `Task ${this.taskId} cannot move from '${this.from}' to '${this.to}'. From '${this.from}' it can go to: ${allowed.join(", ")}.`;
  }
}

const activeTasks = (snapshot: OrchestrationReadModel): ReadonlyArray<OrchestrationTask> =>
  snapshot.tasks.filter((task) => task.deletedAt === null);

/** Accepts a full task id or any unambiguous prefix, so ids stay typeable. */
const resolveTask = Effect.fn("resolveTask")(function* (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly identifier: string;
}) {
  const identifier = input.identifier.trim();
  const candidates = activeTasks(input.snapshot);
  const exact = candidates.find((task) => task.id === identifier);
  if (exact) {
    return exact;
  }

  const prefixed = candidates.filter((task) => task.id.startsWith(identifier));
  if (prefixed.length === 1 && prefixed[0]) {
    return prefixed[0];
  }
  if (prefixed.length > 1) {
    return yield* new TaskAmbiguousIdentifierError({
      operation: "resolveTask",
      identifier,
      matches: prefixed.map((task) => task.id),
    });
  }
  return yield* new TaskNotFoundError({ operation: "resolveTask", identifier });
});

const resolveProject = Effect.fn("resolveProject")(function* (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly identifier: string;
}) {
  const identifier = input.identifier.trim();
  const active = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const match =
    active.find((project) => project.id === identifier) ??
    active.find((project) => project.workspaceRoot === identifier);
  if (match) {
    return match;
  }
  return yield* new TaskProjectNotFoundError({
    operation: "resolveTaskProject",
    identifier,
    activeProjectCount: active.length,
  });
});

const parseStatus = Effect.fn("parseStatus")(function* (value: string) {
  const normalized = value.trim().toLowerCase();
  if (isTaskStatus(normalized)) {
    return normalized;
  }
  return yield* new TaskInvalidStatusError({ operation: "parseTaskStatus", status: value });
});

const parsePriority = Effect.fn("parsePriority")(function* (value: string) {
  const normalized = value.trim().toUpperCase();
  if (isTaskPriority(normalized)) {
    return normalized;
  }
  return yield* new TaskInvalidPriorityError({ operation: "parseTaskPriority", priority: value });
});

const formatTaskLine = (task: OrchestrationTask, projectTitle: string): string => {
  const labels = task.labels.length > 0 ? `  [${task.labels.join(", ")}]` : "";
  return `${task.id.slice(0, 8)}  ${task.status.padEnd(8)} ${task.priority}  ${task.title}  (${projectTitle})${labels}`;
};

const taskListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription("Only show tasks for this project id or workspace root."),
    Flag.optional,
  ),
  status: Flag.string("status").pipe(
    Flag.withDescription("Only show tasks in this status."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List tasks."),
  Command.withHandler((flags) =>
    runOrchestrationCliMutation<TaskCliDispatchCommand>(
      CLI_LABEL,
      flags,
      Effect.fn("taskList")(function* ({ snapshot }: TaskCliContext) {
        const projectFilter = Option.getOrUndefined(flags.project);
        const project =
          projectFilter === undefined
            ? null
            : yield* resolveProject({ snapshot, identifier: projectFilter });
        const statusFilter = Option.getOrUndefined(flags.status);
        const status = statusFilter === undefined ? null : yield* parseStatus(statusFilter);

        const titleByProject = new Map(
          snapshot.projects.map((entry) => [entry.id, entry.title] as const),
        );
        const rows = activeTasks(snapshot)
          .filter((task) => (project === null ? true : task.projectId === project.id))
          .filter((task) => (status === null ? true : task.status === status));

        if (rows.length === 0) {
          return "No tasks match.";
        }
        return rows
          .map((task) => formatTaskLine(task, titleByProject.get(task.projectId) ?? task.projectId))
          .join("\n");
      }),
    ),
  ),
);

const taskAddCommand = Command.make("add", {
  ...projectLocationFlags,
  title: Argument.string("title").pipe(Argument.withDescription("Task title.")),
  project: Flag.string("project").pipe(
    Flag.withDescription(
      "Project id or workspace root. Defaults to the only project if there is one.",
    ),
    Flag.optional,
  ),
  priority: Flag.string("priority").pipe(
    Flag.withDescription("P0, P1, P2 or P3. Defaults to P2."),
    Flag.optional,
  ),
  body: Flag.string("body").pipe(
    Flag.withDescription("Goal and acceptance criteria."),
    Flag.optional,
  ),
  label: Flag.string("label").pipe(Flag.withDescription("Label to attach."), Flag.atLeast(0)),
}).pipe(
  Command.withDescription("Add a task."),
  Command.withHandler((flags) =>
    runOrchestrationCliMutation<TaskCliDispatchCommand>(
      CLI_LABEL,
      flags,
      Effect.fn("taskAdd")(function* ({ snapshot, dispatch }: TaskCliContext) {
        const projectFlag = Option.getOrUndefined(flags.project);
        const activeProjects = snapshot.projects.filter((project) => project.deletedAt === null);
        // With exactly one project, requiring --project is friction for nothing.
        const project =
          projectFlag !== undefined
            ? yield* resolveProject({ snapshot, identifier: projectFlag })
            : activeProjects.length === 1 && activeProjects[0]
              ? activeProjects[0]
              : yield* new TaskProjectNotFoundError({
                  operation: "resolveTaskProject",
                  identifier: "<--project not given>",
                  activeProjectCount: activeProjects.length,
                });

        const priorityFlag = Option.getOrUndefined(flags.priority);
        const priority =
          priorityFlag === undefined ? DEFAULT_TASK_PRIORITY : yield* parsePriority(priorityFlag);
        const body = Option.getOrUndefined(flags.body);
        const taskId = TaskId.make(yield* cliCommandUuid);

        yield* dispatch({
          type: "task.create",
          commandId: CommandId.make(yield* cliCommandUuid),
          taskId,
          projectId: ProjectId.make(project.id),
          title: flags.title,
          priority,
          ...(body === undefined ? {} : { body }),
          ...(flags.label.length > 0 ? { labels: flags.label } : {}),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        return `Added task ${taskId} (${flags.title}) to ${project.title} as pending/${priority}.`;
      }),
    ),
  ),
);

const taskMoveCommand = Command.make("move", {
  ...projectLocationFlags,
  task: Argument.string("task").pipe(Argument.withDescription("Task id or unique id prefix.")),
  status: Argument.string("status").pipe(
    Argument.withDescription(
      "Destination status: pending, planning, running, review, fixing, blocked or done.",
    ),
  ),
}).pipe(
  Command.withDescription("Move a task to another status."),
  Command.withHandler((flags) =>
    runOrchestrationCliMutation<TaskCliDispatchCommand>(
      CLI_LABEL,
      flags,
      Effect.fn("taskMove")(function* ({ snapshot, dispatch }: TaskCliContext) {
        const task = yield* resolveTask({ snapshot, identifier: flags.task });
        const status = yield* parseStatus(flags.status);
        if (task.status === status) {
          return `Task ${task.id} is already ${status}.`;
        }
        // Checked here as well as in the decider so the CLI can name the legal
        // moves instead of surfacing a bare invariant failure.
        if (!canTransitionTask(task.status, status)) {
          return yield* new TaskIllegalTransitionError({
            operation: "moveTask",
            taskId: task.id,
            from: task.status,
            to: status,
          });
        }

        yield* dispatch({
          type: "task.status.set",
          commandId: CommandId.make(yield* cliCommandUuid),
          taskId: TaskId.make(task.id),
          status,
        });
        return `Moved task ${task.id} from ${task.status} to ${status}.`;
      }),
    ),
  ),
);

const taskEditCommand = Command.make("edit", {
  ...projectLocationFlags,
  task: Argument.string("task").pipe(Argument.withDescription("Task id or unique id prefix.")),
  title: Flag.string("title").pipe(Flag.withDescription("New title."), Flag.optional),
  priority: Flag.string("priority").pipe(Flag.withDescription("New priority."), Flag.optional),
  body: Flag.string("body").pipe(
    Flag.withDescription("New goal and acceptance criteria."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Edit a task's title, priority or body."),
  Command.withHandler((flags) =>
    runOrchestrationCliMutation<TaskCliDispatchCommand>(
      CLI_LABEL,
      flags,
      Effect.fn("taskEdit")(function* ({ snapshot, dispatch }: TaskCliContext) {
        const task = yield* resolveTask({ snapshot, identifier: flags.task });
        const title = Option.getOrUndefined(flags.title);
        const priorityFlag = Option.getOrUndefined(flags.priority);
        const body = Option.getOrUndefined(flags.body);
        if (title === undefined && priorityFlag === undefined && body === undefined) {
          return `Nothing to change on task ${task.id}. Pass --title, --priority or --body.`;
        }
        const priority =
          priorityFlag === undefined ? undefined : yield* parsePriority(priorityFlag);

        yield* dispatch({
          type: "task.meta.update",
          commandId: CommandId.make(yield* cliCommandUuid),
          taskId: TaskId.make(task.id),
          ...(title === undefined ? {} : { title }),
          ...(priority === undefined ? {} : { priority }),
          ...(body === undefined ? {} : { body }),
        });
        return `Updated task ${task.id}.`;
      }),
    ),
  ),
);

const taskRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  task: Argument.string("task").pipe(Argument.withDescription("Task id or unique id prefix.")),
}).pipe(
  Command.withDescription("Remove a task."),
  Command.withHandler((flags) =>
    runOrchestrationCliMutation<TaskCliDispatchCommand>(
      CLI_LABEL,
      flags,
      Effect.fn("taskRemove")(function* ({ snapshot, dispatch }: TaskCliContext) {
        const task = yield* resolveTask({ snapshot, identifier: flags.task });
        yield* dispatch({
          type: "task.delete",
          commandId: CommandId.make(yield* cliCommandUuid),
          taskId: TaskId.make(task.id),
        });
        return `Removed task ${task.id} (${task.title}).`;
      }),
    ),
  ),
);

export const taskCommand = Command.make("task").pipe(
  Command.withDescription("Manage tasks."),
  Command.withSubcommands([
    taskListCommand,
    taskAddCommand,
    taskMoveCommand,
    taskEditCommand,
    taskRemoveCommand,
  ]),
);
