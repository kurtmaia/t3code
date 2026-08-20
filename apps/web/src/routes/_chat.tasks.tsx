import {
  DndContext,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { EnvironmentTask, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  TASK_STATUS_TRANSITIONS,
  TaskId,
  canTransitionTask,
  type TaskPriority,
  type TaskStatus,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { useComposerDraftStore } from "~/composerDraftStore";
import { newTaskId, newThreadId } from "~/lib/utils";
import { useProjects, useTasks, useThreadShells } from "~/state/entities";
import { taskEnvironment } from "~/state/taskCommands";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

const COLUMNS = Object.keys(TASK_STATUS_TRANSITIONS) as ReadonlyArray<TaskStatus>;

// The columns a board is actually read from day to day. The rest are real
// states a task passes through, but showing all seven at once makes every one
// of them narrow and pushes the useful ones off-screen.
const DEFAULT_COLUMNS: ReadonlyArray<TaskStatus> = ["pending", "running", "review", "done"];
const COLUMNS_STORAGE_KEY = "t3.tasks.columns";

const COLUMN_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  planning: "Planning",
  running: "Running",
  review: "Review",
  fixing: "Fixing",
  blocked: "Blocked",
  done: "Done",
};

const PRIORITIES: ReadonlyArray<TaskPriority> = ["P0", "P1", "P2", "P3"];

const PRIORITY_TONE: Record<TaskPriority, string> = {
  P0: "text-destructive",
  P1: "text-foreground",
  P2: "text-muted-foreground",
  P3: "text-muted-foreground",
};

function readStoredColumns(): ReadonlyArray<TaskStatus> {
  try {
    const raw = globalThis.localStorage?.getItem(COLUMNS_STORAGE_KEY);
    if (raw === null || raw === undefined) return DEFAULT_COLUMNS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COLUMNS;
    const valid = parsed.filter((entry): entry is TaskStatus =>
      COLUMNS.includes(entry as TaskStatus),
    );
    // An empty selection would render a board with nothing on it.
    return valid.length > 0 ? valid : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

/** Case-insensitive match across the text a reader would search by. */
function matchesQuery(task: EnvironmentTask, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    task.title.toLowerCase().includes(needle) ||
    task.body.toLowerCase().includes(needle) ||
    task.labels.some((label) => label.toLowerCase().includes(needle))
  );
}

function TaskCard({
  task,
  projectTitle,
  threadCount,
  selected,
  onSelect,
  onDelete,
}: {
  readonly task: EnvironmentTask;
  readonly projectTitle: string;
  readonly threadCount: number;
  readonly selected: boolean;
  readonly onSelect: (task: EnvironmentTask) => void;
  readonly onDelete: (task: EnvironmentTask) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`group w-full min-w-0 rounded-md border bg-background p-2 text-left ${
        selected ? "border-primary" : "border-border"
      } ${isDragging ? "opacity-50" : ""}`}
      onClick={() => onSelect(task)}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm leading-snug break-words">{task.title}</span>
        <span className={`shrink-0 text-xs font-medium ${PRIORITY_TONE[task.priority]}`}>
          {task.priority}
        </span>
      </div>
      <div className="mt-1.5 flex w-full min-w-0 flex-wrap items-center gap-1">
        <span className="max-w-full truncate text-xs text-muted-foreground">{projectTitle}</span>
        {threadCount > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
            <MessagesSquareIcon className="size-3" />
            {threadCount}
          </span>
        ) : null}
        {task.source === "tower" ? (
          <Badge size="sm" variant="outline">
            tower
          </Badge>
        ) : null}
        {task.labels.map((label) => (
          <Badge className="max-w-full truncate" key={label} size="sm" variant="outline">
            {label}
          </Badge>
        ))}
      </div>
      <div className="mt-1.5 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          aria-label={`Delete ${task.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(task);
          }}
          size="icon"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}

function Column({
  status,
  tasks,
  projectTitles,
  threadCounts,
  draggedStatus,
  selectedTaskId,
  onSelect,
  onDelete,
  compact = false,
}: {
  readonly status: TaskStatus;
  readonly tasks: ReadonlyArray<EnvironmentTask>;
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly threadCounts: ReadonlyMap<string, number>;
  readonly draggedStatus: TaskStatus | null;
  readonly selectedTaskId: string | null;
  readonly onSelect: (task: EnvironmentTask) => void;
  readonly onDelete: (task: EnvironmentTask) => void;
  readonly compact?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  // While a card is in flight, a column it cannot legally receive is dimmed
  // rather than hidden: the board teaches the lifecycle instead of hiding it.
  const illegalTarget =
    draggedStatus !== null && draggedStatus !== status && !canTransitionTask(draggedStatus, status);
  return (
    <div
      ref={setNodeRef}
      className={`flex ${compact ? "w-full min-w-0" : "w-64 shrink-0"} flex-col rounded-lg border border-border bg-muted/40 ${
        isOver && !illegalTarget ? "border-primary" : ""
      } ${illegalTarget ? "opacity-40" : ""}`}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium">{COLUMN_LABELS[status]}</span>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </div>
      <div className="flex min-h-24 flex-col gap-2 px-2 pb-2">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            onDelete={onDelete}
            onSelect={onSelect}
            projectTitle={projectTitles.get(task.projectId) ?? task.projectId}
            selected={selectedTaskId === task.id}
            task={task}
            threadCount={threadCounts.get(task.id) ?? 0}
          />
        ))}
      </div>
    </div>
  );
}

function TaskDetail({
  task,
  threads,
  attachable,
  onClose,
  onAttach,
  onDetach,
  onOpenThread,
  onEdit,
  onMove,
  onNewThread,
  onPlanWithAgent,
  runningThreadCount,
  compact = false,
}: {
  readonly task: EnvironmentTask;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly attachable: ReadonlyArray<EnvironmentThreadShell>;
  readonly onClose: () => void;
  readonly onAttach: (thread: EnvironmentThreadShell) => void;
  readonly onDetach: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly onEdit: (
    task: EnvironmentTask,
    changes: {
      readonly title?: string;
      readonly body?: string;
      readonly priority?: TaskPriority;
      readonly planMarkdown?: string;
    },
  ) => void;
  readonly onMove: (task: EnvironmentTask, status: TaskStatus) => void;
  readonly onNewThread: (task: EnvironmentTask) => void;
  readonly onPlanWithAgent: (task: EnvironmentTask) => void;
  readonly runningThreadCount: number;
  readonly compact?: boolean;
}) {
  const [attaching, setAttaching] = useState(false);
  // Seeded once per task: the panel is keyed by task id, so selecting another
  // card remounts it. A server echo mid-edit therefore cannot overwrite what
  // the user is still typing.
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftBody, setDraftBody] = useState(task.body);
  const [draftPlan, setDraftPlan] = useState(task.planMarkdown ?? "");

  const commitTitle = () => {
    const next = draftTitle.trim();
    // An empty title is not a rename; put the real one back.
    if (next.length === 0) {
      setDraftTitle(task.title);
      return;
    }
    if (next !== task.title) onEdit(task, { title: next });
  };

  const commitBody = () => {
    if (draftBody !== task.body) onEdit(task, { body: draftBody });
  };

  const commitPlan = () => {
    if (draftPlan !== (task.planMarkdown ?? "")) onEdit(task, { planMarkdown: draftPlan });
  };

  return (
    <aside
      className={
        compact
          ? "absolute inset-0 z-20 flex flex-col overflow-y-auto bg-background p-4"
          : "flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border p-4"
      }
    >
      <div className="flex items-start gap-2">
        <Input
          aria-label="Task title"
          className="min-w-0 flex-1"
          onBlur={commitTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setDraftTitle(task.title);
          }}
          value={draftTitle}
        />
        <Button aria-label="Close task details" onClick={onClose} size="icon" variant="ghost">
          <XIcon />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">Move to</span>
        {(TASK_STATUS_TRANSITIONS[task.status] as ReadonlyArray<TaskStatus>).map((next) => (
          <Button key={next} onClick={() => onMove(task, next)} size="sm" variant="outline">
            {COLUMN_LABELS[next]}
          </Button>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-1">
        {PRIORITIES.map((priority) => (
          <Button
            aria-label={`Set priority ${priority}`}
            aria-pressed={task.priority === priority}
            key={priority}
            onClick={() => {
              if (task.priority !== priority) onEdit(task, { priority });
            }}
            size="sm"
            variant={task.priority === priority ? "default" : "ghost"}
          >
            {priority}
          </Button>
        ))}
      </div>

      <Textarea
        aria-label="Task body"
        className="mt-2"
        onBlur={commitBody}
        onChange={(event) => setDraftBody(event.target.value)}
        placeholder="Goal and acceptance criteria"
        rows={8}
        value={draftBody}
      />

      {task.source === "tower" ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Imported from tower. Edits stay here — the source file is never written back.
        </p>
      ) : null}

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">Plan</h3>
          <Button onClick={() => onPlanWithAgent(task)} size="sm" variant="ghost">
            Plan with agent
          </Button>
        </div>
        <Textarea
          aria-label="Task plan"
          className="mt-1"
          onBlur={commitPlan}
          onChange={(event) => setDraftPlan(event.target.value)}
          placeholder="The agreed approach. Every thread started here begins with it."
          rows={5}
          value={draftPlan}
        />
        {draftPlan.trim().length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            A plan already exists, so a new one from an agent stays in its thread rather than
            replacing this. Clear this box first to have it filled automatically.
          </p>
        ) : null}
      </div>

      {runningThreadCount > 1 ? (
        <p className="mt-3 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
          {runningThreadCount} threads are running in this task&apos;s workspace. They share one
          working copy, so overlapping edits land on top of each other.
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">Threads</h3>
        <div className="flex items-center gap-1">
          <Button onClick={() => setAttaching((open) => !open)} size="sm" variant="ghost">
            {attaching ? "Cancel" : "Attach"}
          </Button>
          <Button onClick={() => onNewThread(task)} size="sm" variant="outline">
            New thread
          </Button>
        </div>
      </div>

      {threads.length === 0 && !attaching ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No threads yet. Attach one to group the work that shares this task&apos;s context.
        </p>
      ) : null}

      <ul className="mt-2 flex flex-col gap-1">
        {threads.map((thread) => (
          <li className="flex items-center gap-1" key={thread.id}>
            <button
              className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
              onClick={() => onOpenThread(thread)}
              type="button"
            >
              {thread.title}
            </button>
            <Button
              aria-label={`Detach ${thread.title}`}
              onClick={() => onDetach(thread)}
              size="icon"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>

      {attaching ? (
        <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
          {attachable.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Every thread in this project already belongs to a task.
            </p>
          ) : (
            attachable.map((thread) => (
              <button
                className="truncate rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                key={thread.id}
                onClick={() => {
                  onAttach(thread);
                  setAttaching(false);
                }}
                type="button"
              >
                {thread.title}
              </button>
            ))
          )}
        </div>
      ) : null}
    </aside>
  );
}

function TasksPage() {
  const tasks = useTasks();
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [draggedStatus, setDraggedStatus] = useState<TaskStatus | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] =
    useState<ReadonlyArray<TaskStatus>>(readStoredColumns);
  const isMobile = useIsMobile();
  // A phone shows one column at a time; seven side by side is unreadable and
  // horizontal scrolling fights the page's own scroll.
  const [mobileStatus, setMobileStatus] = useState<TaskStatus>("pending");

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(visibleColumns));
    } catch {
      // A board that cannot remember its columns still works.
    }
  }, [visibleColumns]);

  const createTask = useAtomCommand(taskEnvironment.create);
  const updateTask = useAtomCommand(taskEnvironment.update);
  const setTaskStatus = useAtomCommand(taskEnvironment.setStatus);
  const deleteTask = useAtomCommand(taskEnvironment.delete);
  const updateThread = useAtomCommand(threadEnvironment.updateMetadata);
  const createThread = useAtomCommand(threadEnvironment.create);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args);
  }, []);

  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id as string, project.title] as const)),
    [projects],
  );

  const threadsByTask = useMemo(() => {
    const grouped = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of threads) {
      const taskId = thread.taskId ?? null;
      if (taskId === null) continue;
      const bucket = grouped.get(taskId);
      if (bucket === undefined) grouped.set(taskId, [thread]);
      else bucket.push(thread);
    }
    return grouped;
  }, [threads]);

  const threadCounts = useMemo(
    () => new Map([...threadsByTask].map(([taskId, list]) => [taskId, list.length] as const)),
    [threadsByTask],
  );

  const visible = useMemo(
    () => tasks.filter((task) => matchesQuery(task, query.trim())),
    [query, tasks],
  );

  const byStatus = useMemo(() => {
    const grouped = new Map<TaskStatus, EnvironmentTask[]>(COLUMNS.map((status) => [status, []]));
    for (const task of visible) {
      grouped.get(task.status)?.push(task);
    }
    return grouped;
  }, [visible]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  );

  // A board with no project to file a task against cannot create one.
  const target = projects[0] ?? null;

  const handleCreate = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || target === null) return;
    setTitle("");
    void createTask({
      environmentId: target.environmentId,
      input: { taskId: newTaskId(), projectId: target.id, title: trimmed },
    });
  }, [createTask, target, title]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = tasks.find((entry) => entry.id === event.active.id);
      setDraggedStatus(task?.status ?? null);
    },
    [tasks],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedStatus(null);
      const over = event.over;
      if (over === null) return;
      const task = tasks.find((entry) => entry.id === event.active.id);
      if (task === undefined) return;
      const status = over.id as TaskStatus;
      // The server is authoritative; refusing here keeps a doomed round trip
      // (and a flash of the card in the wrong column) off the wire.
      if (task.status === status || !canTransitionTask(task.status, status)) return;
      void setTaskStatus({
        environmentId: task.environmentId,
        input: { taskId: TaskId.make(task.id), status },
      });
    },
    [setTaskStatus, tasks],
  );

  const handleDelete = useCallback(
    (task: EnvironmentTask) => {
      if (selectedTaskId === task.id) setSelectedTaskId(null);
      void deleteTask({
        environmentId: task.environmentId,
        input: { taskId: TaskId.make(task.id) },
      });
    },
    [deleteTask, selectedTaskId],
  );

  const handleEdit = useCallback(
    (
      task: EnvironmentTask,
      changes: {
        readonly title?: string;
        readonly body?: string;
        readonly priority?: TaskPriority;
      },
    ) => {
      // Only changed fields travel: an absent field leaves that value alone,
      // so editing a title can never blank a body someone else just wrote.
      void updateTask({
        environmentId: task.environmentId,
        input: { taskId: TaskId.make(task.id), ...changes },
      });
    },
    [updateTask],
  );

  const handleMove = useCallback(
    (task: EnvironmentTask, status: TaskStatus) => {
      if (task.status === status || !canTransitionTask(task.status, status)) return;
      void setTaskStatus({
        environmentId: task.environmentId,
        input: { taskId: TaskId.make(task.id), status },
      });
    },
    [setTaskStatus],
  );

  // The brief a thread on this task starts from. Seeded into the composer
  // rather than injected server-side: the text is visible before it is sent,
  // and it works the same for every provider.
  const buildTaskBrief = useCallback((task: EnvironmentTask) => {
    const sections = [`# ${task.title}`];
    if (task.body.trim().length > 0) sections.push(task.body.trim());
    const plan = task.planMarkdown?.trim() ?? "";
    if (plan.length > 0) sections.push(`## Plan\n\n${plan}`);
    return `${sections.join("\n\n")}\n\n---\n\n`;
  }, []);

  // Created directly rather than through the draft flow: only thread.create
  // carries a taskId, and the thread has to be linked at birth for the board
  // to group it. The workspace comes from the task, so a second thread joins
  // the worktree the first one established instead of making its own.
  const startTaskThread = useCallback(
    (task: EnvironmentTask, options?: { readonly plan?: boolean }) => {
      const project = projects.find(
        (entry) => entry.id === task.projectId && entry.environmentId === task.environmentId,
      );
      const modelSelection = project?.defaultModelSelection ?? null;
      if (modelSelection === null) return;

      const threadId = newThreadId();
      void createThread({
        environmentId: task.environmentId,
        input: {
          threadId,
          projectId: task.projectId,
          taskId: TaskId.make(task.id),
          title: task.title,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: options?.plan === true ? "plan" : DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: task.branch ?? null,
          worktreePath: task.worktreePath ?? null,
          createdAt: new Date().toISOString(),
        },
      }).then((result) => {
        if (result._tag !== "Success") return;
        const ref = scopeThreadRef(task.environmentId, threadId);
        // In plan mode the ask is explicit: the agent should read enough to
        // propose an approach, and the promotion reactor copies whatever plan
        // it produces onto the task when the task has none yet.
        const prompt =
          options?.plan === true
            ? `${buildTaskBrief(task)}Read the relevant code and propose an implementation plan for this task. Do not change anything yet.`
            : buildTaskBrief(task);
        useComposerDraftStore.getState().setPrompt(ref, prompt);
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: task.environmentId, threadId },
        });
      });
    },
    [buildTaskBrief, createThread, navigate, projects],
  );

  const handleNewTaskThread = useCallback(
    (task: EnvironmentTask) => startTaskThread(task),
    [startTaskThread],
  );
  const handlePlanWithAgent = useCallback(
    (task: EnvironmentTask) => startTaskThread(task, { plan: true }),
    [startTaskThread],
  );

  const setThreadTask = useCallback(
    (thread: EnvironmentThreadShell, taskId: TaskId | null) => {
      void updateThread({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, taskId },
      });
    },
    [updateThread],
  );

  const toggleColumn = useCallback((status: TaskStatus) => {
    setVisibleColumns((current) => {
      const next = current.includes(status)
        ? current.filter((entry) => entry !== status)
        : [...COLUMNS].filter((entry) => entry === status || current.includes(entry));
      return next.length > 0 ? next : current;
    });
  }, []);

  const selectedThreads = selectedTask ? (threadsByTask.get(selectedTask.id) ?? []) : [];
  const attachableThreads = selectedTask
    ? threads.filter(
        (thread) =>
          thread.projectId === selectedTask.projectId &&
          thread.environmentId === selectedTask.environmentId &&
          (thread.taskId ?? null) === null,
      )
    : [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4 sm:py-3">
        <h1 className="text-sm font-medium">Tasks</h1>

        <div className="relative min-w-0 flex-1 sm:flex-none">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search tasks"
            className="w-full pl-7 sm:w-56"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, body, labels"
            value={query}
          />
        </div>

        <div className="hidden flex-wrap items-center gap-1 sm:flex">
          {COLUMNS.map((status) => (
            <Button
              aria-pressed={visibleColumns.includes(status)}
              key={status}
              onClick={() => toggleColumn(status)}
              size="sm"
              variant={visibleColumns.includes(status) ? "default" : "ghost"}
            >
              {COLUMN_LABELS[status]}
            </Button>
          ))}
        </div>

        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <Input
            aria-label="New task title"
            className="min-w-0 flex-1 sm:w-56 sm:flex-none"
            disabled={target === null}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleCreate();
            }}
            placeholder={target === null ? "Add a project first" : `New task in ${target.title}`}
            value={title}
          />
          <Button
            aria-label="Add task"
            disabled={target === null || title.trim().length === 0}
            onClick={handleCreate}
            size="icon"
          >
            <PlusIcon />
          </Button>
        </div>
      </div>

      {tasks.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No tasks yet. Add one above, or run <code>t3 task add &quot;…&quot;</code>.
        </p>
      ) : visible.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No tasks match “{query.trim()}”.</p>
      ) : null}

      <div className="relative flex min-h-0 w-full min-w-0 flex-1">
        {isMobile ? (
          <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
            {/* Status picker instead of seven columns. Counts stay visible so the
              board still reads as a board rather than a filtered list. */}
            <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
              {COLUMNS.map((status) => (
                <Button
                  aria-pressed={mobileStatus === status}
                  className="shrink-0"
                  key={status}
                  onClick={() => setMobileStatus(status)}
                  size="sm"
                  variant={mobileStatus === status ? "default" : "ghost"}
                >
                  {COLUMN_LABELS[status]}
                  <span className="ml-1 text-muted-foreground">
                    {(byStatus.get(status) ?? []).length}
                  </span>
                </Button>
              ))}
            </div>
            {/* No DndContext on touch: a drag sensor competes with the scroll
              gesture, and the detail panel's Move buttons are both reliable and
              self-documenting about which moves are legal. */}
            <div className="min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
              <Column
                compact
                draggedStatus={null}
                onDelete={handleDelete}
                onSelect={(task) => setSelectedTaskId(task.id)}
                projectTitles={projectTitles}
                selectedTaskId={selectedTaskId}
                status={mobileStatus}
                tasks={byStatus.get(mobileStatus) ?? []}
                threadCounts={threadCounts}
              />
            </div>
          </div>
        ) : (
          <DndContext
            collisionDetection={collisionDetection}
            onDragEnd={handleDragEnd}
            onDragStart={handleDragStart}
            sensors={sensors}
          >
            {/* overflow-x-scroll, not auto: a board that is one column too wide
                should say so rather than hide the fact until you scroll. */}
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-scroll p-4">
              {COLUMNS.filter((status) => visibleColumns.includes(status)).map((status) => (
                <Column
                  draggedStatus={draggedStatus}
                  key={status}
                  onDelete={handleDelete}
                  onSelect={(task) => setSelectedTaskId(task.id)}
                  projectTitles={projectTitles}
                  selectedTaskId={selectedTaskId}
                  status={status}
                  tasks={byStatus.get(status) ?? []}
                  threadCounts={threadCounts}
                />
              ))}
            </div>
          </DndContext>
        )}

        {selectedTask ? (
          <TaskDetail
            attachable={attachableThreads}
            key={selectedTask.id}
            onAttach={(thread) => setThreadTask(thread, TaskId.make(selectedTask.id))}
            onClose={() => setSelectedTaskId(null)}
            onDetach={(thread) => setThreadTask(thread, null)}
            compact={isMobile}
            onEdit={handleEdit}
            onMove={handleMove}
            onNewThread={handleNewTaskThread}
            onPlanWithAgent={handlePlanWithAgent}
            runningThreadCount={
              selectedThreads.filter(
                (thread) => thread.latestTurn !== null && thread.latestTurn.state === "running",
              ).length
            }
            onOpenThread={(thread) => {
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: thread.environmentId, threadId: thread.id },
              });
            }}
            task={selectedTask}
            threads={selectedThreads}
          />
        ) : null}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/tasks")({
  component: TasksPage,
});
