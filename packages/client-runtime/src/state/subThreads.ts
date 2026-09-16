/**
 * Sub-thread building blocks shared by web and mobile: quote truncation, the
 * seeded first prompt, thread titles, the create/start-turn inputs, and the
 * shell-derived selectors that power quote anchors and nested thread lists.
 *
 * Everything here is pure. The quote is injected into the first user message
 * client-side (mirroring the plan-implementation flow); the server only
 * stores `parentThreadId`/`sourceQuote` as provenance and never re-injects.
 */
import {
  THREAD_SOURCE_QUOTE_MAX_LENGTH,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type ThreadSourceQuote,
} from "@t3tools/contracts";

const SUB_THREAD_TITLE_SNIPPET_MAX_LENGTH = 48;

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const slice = text.slice(0, maxLength - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxLength / 2 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** Trim a selection down to what the source-quote contract accepts. */
export function truncateQuote(text: string): string {
  return truncateAtWordBoundary(text.trim(), THREAD_SOURCE_QUOTE_MAX_LENGTH);
}

/** Single-line snippet of a quote, for titles and anchor chips. */
export function subThreadQuoteSnippet(quoteText: string): string {
  return truncateAtWordBoundary(
    quoteText.trim().replace(/\s+/g, " "),
    SUB_THREAD_TITLE_SNIPPET_MAX_LENGTH,
  );
}

export function buildSubThreadTitle(quoteText: string): string {
  const snippet = subThreadQuoteSnippet(quoteText);
  return snippet.length > 0 ? `Re: ${snippet}` : "Side conversation";
}

/**
 * The sub-thread's first user message: the highlighted passage as a
 * blockquote, then the user's question. Self-documenting in the transcript,
 * and the only place the quote reaches the provider.
 */
export function buildSubThreadSeedPrompt(input: {
  readonly quoteText: string;
  readonly question: string;
}): string {
  const quoted = input.quoteText
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    "The user highlighted this passage from an earlier assistant answer in the parent conversation and is asking about it specifically:",
    "",
    quoted,
    "",
    input.question.trim(),
  ].join("\n");
}

/**
 * The `thread.create` + `thread.turn.start` inputs for a sub-thread, mirroring
 * the plan-implementation flow: join the parent's worktree (never bootstrap a
 * new one), start in the caller-supplied mode (the parent's), seed the title
 * from the quote but leave it replaceable by auto-titling via `titleSeed`.
 */
export function buildSubThreadCreation(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly parent: Pick<
    OrchestrationThreadShell,
    "id" | "projectId" | "branch" | "worktreePath" | "taskId"
  >;
  readonly quote: ThreadSourceQuote;
  /** The full first-message text, built from `buildSubThreadSeedPrompt` and
      run through any provider-specific outgoing formatting by the caller. */
  readonly promptText: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
}) {
  const title = buildSubThreadTitle(input.quote.text);
  return {
    createInput: {
      threadId: input.threadId,
      projectId: input.parent.projectId,
      parentThreadId: input.parent.id,
      sourceQuote: input.quote,
      taskId: input.parent.taskId ?? null,
      title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: input.parent.branch,
      worktreePath: input.parent.worktreePath,
      createdAt: input.createdAt,
    },
    startInput: {
      threadId: input.threadId,
      message: {
        messageId: input.messageId,
        role: "user" as const,
        text: input.promptText,
        attachments: [],
      },
      modelSelection: input.modelSelection,
      titleSeed: title,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: input.createdAt,
    },
  };
}

export interface SubThreadAnchor {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly messageId: MessageId;
  readonly quoteText: string;
}

/**
 * Anchors grouped parent → message, from shell data alone. `parentThreadId`
 * and `sourceQuote` are write-once at creation, so memoizing on the shells
 * array is stable: the result only changes when threads appear or disappear.
 */
export function selectSubThreadAnchors(
  shells: ReadonlyArray<OrchestrationThreadShell>,
): ReadonlyMap<ThreadId, ReadonlyMap<MessageId, ReadonlyArray<SubThreadAnchor>>> {
  const byParent = new Map<ThreadId, Map<MessageId, Array<SubThreadAnchor>>>();
  for (const shell of shells) {
    const parentThreadId = shell.parentThreadId ?? null;
    const sourceQuote = shell.sourceQuote ?? null;
    if (parentThreadId === null || sourceQuote === null) {
      continue;
    }
    const byMessage = byParent.get(parentThreadId) ?? new Map<MessageId, Array<SubThreadAnchor>>();
    const anchors = byMessage.get(sourceQuote.messageId) ?? [];
    anchors.push({
      threadId: shell.id,
      parentThreadId,
      messageId: sourceQuote.messageId,
      quoteText: sourceQuote.text,
    });
    byMessage.set(sourceQuote.messageId, anchors);
    byParent.set(parentThreadId, byMessage);
  }
  return byParent;
}

/**
 * Split shells into top-level threads and children keyed by parent, promoting
 * orphans (parent deleted, archived, or filtered out of `shells`) to the top
 * level so no thread ever becomes unreachable. List builders on every surface
 * nest from this one partition.
 */
export function partitionThreadShellsByParent<
  Shell extends Pick<OrchestrationThreadShell, "id" | "parentThreadId">,
>(
  shells: ReadonlyArray<Shell>,
): {
  readonly topLevel: ReadonlyArray<Shell>;
  readonly childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<Shell>>;
} {
  const present = new Set(shells.map((shell) => shell.id));
  const topLevel: Array<Shell> = [];
  const childrenByParent = new Map<ThreadId, Array<Shell>>();
  for (const shell of shells) {
    const parentThreadId = shell.parentThreadId ?? null;
    if (parentThreadId === null || !present.has(parentThreadId)) {
      topLevel.push(shell);
      continue;
    }
    const children = childrenByParent.get(parentThreadId) ?? [];
    children.push(shell);
    childrenByParent.set(parentThreadId, children);
  }
  return { topLevel, childrenByParent };
}
