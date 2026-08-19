import {
  DEFAULT_TASK_PRIORITY,
  TaskPriority,
  TaskStatus,
  type OrchestrationTask,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

/**
 * Reads tasks out of a project's committed `.tower/tasks` folder.
 *
 * Import is deliberately one-way. Tower's task store is a single-writer design
 * guarded by a file lock — agents append to a sidecar event log rather than
 * touch the markdown — so writing back from here would break the invariant
 * that keeps concurrent edits from being lost. t3 reads; tower still owns.
 */
export const TOWER_TASKS_RELATIVE_DIR = ".tower/tasks";

/** Fields t3 has somewhere to put. Everything else in tower's frontmatter
    (assignee, model, tools, scope, verify, isolation, base_ref, depends_on,
    runs, machine) is dropped rather than half-modelled. */
const TowerFrontmatter = Schema.Struct({
  title: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  labels: Schema.optional(Schema.Array(Schema.String)),
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
});

const decodeFrontmatter = Schema.decodeUnknownOption(TowerFrontmatter);

export interface TowerTaskDraft {
  /** Filename stem. Tower treats the filename as authoritative over a
      frontmatter `id`, which may have been mistyped or copy-pasted. */
  readonly externalId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly orderKey: string | null;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFrontmatter(contents: string): {
  readonly frontmatter: unknown;
  readonly body: string;
} {
  const match = FRONTMATTER.exec(contents);
  if (match === null || match[1] === undefined) {
    return { frontmatter: null, body: contents.trim() };
  }
  let parsed: unknown = null;
  try {
    parsed = parseYamlDocument(match[1]);
  } catch {
    // A task whose frontmatter is malformed still has a readable body; the
    // filename carries its identity, so it imports as an untriaged card
    // rather than being silently skipped.
    parsed = null;
  }
  return { frontmatter: parsed, body: contents.slice(match[0].length).trim() };
}

const isTaskStatus = Schema.is(TaskStatus);
const isTaskPriority = Schema.is(TaskPriority);

/**
 * Tower's statuses are t3's, with one exception: `needs-app-slot` encodes
 * tower's own concurrency limiter, which t3 does not model. It lands in
 * `blocked` because that is what it means to a reader — waiting on something
 * outside the task.
 */
export function mapTowerStatus(value: string | undefined): TaskStatus {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "needs-app-slot") return "blocked";
  return isTaskStatus(normalized) ? normalized : "pending";
}

export function mapTowerPriority(value: string | undefined): TaskPriority {
  const normalized = value?.trim().toUpperCase() ?? "";
  return isTaskPriority(normalized) ? normalized : DEFAULT_TASK_PRIORITY;
}

/**
 * Tower orders within a column with an integer; t3 sorts order keys as
 * strings. Zero-padding keeps 2 ahead of 10, which a raw `String(n)` would not.
 */
export function towerOrderKey(order: number | string | undefined): string | null {
  const numeric = typeof order === "string" ? Number.parseInt(order, 10) : order;
  if (numeric === undefined || !Number.isFinite(numeric)) return null;
  const clamped = Math.max(0, Math.trunc(numeric));
  return clamped.toString().padStart(6, "0");
}

function titleFromExternalId(externalId: string): string {
  // `003-add-coverage-badge` -> `add coverage badge`, so a task with no
  // frontmatter title still reads as something.
  const withoutSeq = externalId.replace(/^\d+[-_]/, "");
  const words = withoutSeq.replace(/[-_]+/g, " ").trim();
  return words.length > 0 ? words : externalId;
}

/**
 * Parses one `.tower/tasks/<stem>.md` file. Returns null only when the file
 * has nothing usable at all.
 */
export function parseTowerTaskFile(input: {
  readonly externalId: string;
  readonly contents: string;
}): TowerTaskDraft | null {
  const externalId = input.externalId.trim();
  if (externalId.length === 0) return null;

  const { frontmatter, body } = splitFrontmatter(input.contents);
  const decoded = decodeFrontmatter(frontmatter);
  const fields = decoded._tag === "Some" ? decoded.value : {};

  const title = fields.title?.trim();
  const labels = (fields.labels ?? [])
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

  return {
    externalId,
    title: title !== undefined && title.length > 0 ? title : titleFromExternalId(externalId),
    status: mapTowerStatus(fields.status),
    priority: mapTowerPriority(fields.priority),
    body,
    labels,
    orderKey: towerOrderKey(fields.order),
  };
}

/** Tasks already imported for a project, keyed so a re-import is a no-op. */
export function importedExternalIds(
  tasks: ReadonlyArray<OrchestrationTask>,
  projectId: string,
): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.projectId !== projectId) continue;
    if (task.source !== "tower") continue;
    if (task.externalId === null || task.externalId === undefined) continue;
    seen.add(task.externalId);
  }
  return seen;
}
