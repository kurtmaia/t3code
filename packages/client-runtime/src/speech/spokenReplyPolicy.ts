/**
 * Decides what a client should say about the thread it is showing. The
 * policy is a pure step function over a small cursor: it speaks a turn's final
 * assistant message once it completes, announces each approval or question
 * the first time it appears, and asks the caller to interrupt speech when a
 * new turn starts or the user moves to another thread. Opening a thread
 * baselines the cursor, so history is never read back.
 */

export type SpokenReplyTurnState = "running" | "interrupted" | "completed" | "error";

export interface SpokenReplyThreadView {
  readonly threadKey: string;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: SpokenReplyTurnState;
    readonly assistantMessageId: string | null;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly turnId: string | null;
  }>;
  readonly pendingApprovals: ReadonlyArray<{
    readonly requestId: string;
    readonly requestKind: "command" | "file-read" | "file-change";
  }>;
  readonly pendingQuestions: ReadonlyArray<{
    readonly requestId: string;
    readonly header: string;
    readonly question: string;
  }>;
}

export interface SpokenReplyCursor {
  readonly threadKey: string;
  /** Last turn whose terminal state was handled, spoken or not. */
  readonly handledTurnId: string | null;
  /** Last turn id observed, so a new turn interrupts speech exactly once. */
  readonly seenTurnId: string | null;
  readonly announcedRequestIds: ReadonlySet<string>;
}

export type SpokenUtterance =
  | { readonly kind: "reply"; readonly turnId: string; readonly markdown: string }
  | { readonly kind: "error"; readonly turnId: string; readonly text: string }
  | { readonly kind: "approval"; readonly requestId: string; readonly text: string }
  | { readonly kind: "question"; readonly requestId: string; readonly text: string };

export interface SpokenReplyStep {
  readonly cursor: SpokenReplyCursor;
  readonly utterances: ReadonlyArray<SpokenUtterance>;
  /** Stop whatever is being read before speaking the new utterances, if any. */
  readonly interrupt: boolean;
}

export const TURN_ERROR_ANNOUNCEMENT = "The agent stopped with an error.";
const QUESTION_MAX_CHARS = 280;

const APPROVAL_ANNOUNCEMENTS = {
  command: "The agent is asking for approval to run a command.",
  "file-read": "The agent is asking for approval to read a file.",
  "file-change": "The agent is asking for approval to change a file.",
} as const;

function pendingRequestIds(view: SpokenReplyThreadView): string[] {
  return [
    ...view.pendingApprovals.map((approval) => approval.requestId),
    ...view.pendingQuestions.map((question) => question.requestId),
  ];
}

function clampQuestion(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= QUESTION_MAX_CHARS) return trimmed;
  const window = trimmed.slice(0, QUESTION_MAX_CHARS);
  const wordEnd = window.lastIndexOf(" ");
  return `${wordEnd > 0 ? window.slice(0, wordEnd) : window}…`;
}

export function questionAnnouncement(question: {
  readonly header: string;
  readonly question: string;
}): string {
  const header = question.header.trim();
  const parts = [header.length > 0 ? `${header}.` : "", clampQuestion(question.question)].filter(
    (part) => part.length > 0,
  );
  return ["The agent has a question.", ...parts].join(" ");
}

function completedTurnMarkdown(view: SpokenReplyThreadView): string | null | "pending" {
  const latestTurn = view.latestTurn;
  if (!latestTurn) return null;
  const message =
    (latestTurn.assistantMessageId !== null
      ? view.messages.find((candidate) => candidate.id === latestTurn.assistantMessageId)
      : undefined) ??
    view.messages.findLast(
      (candidate) => candidate.role === "assistant" && candidate.turnId === latestTurn.turnId,
    );
  if (!message) return null;
  if (message.streaming) return "pending";
  const text = message.text.trim();
  return text.length > 0 ? text : null;
}

/** Cursor for a freshly opened thread: nothing already on screen gets read. */
export function baselineSpokenReplyCursor(view: SpokenReplyThreadView): SpokenReplyCursor {
  const latestTurn = view.latestTurn;
  return {
    threadKey: view.threadKey,
    // A turn still running when the thread opens is spoken once it completes.
    handledTurnId: latestTurn && latestTurn.state !== "running" ? latestTurn.turnId : null,
    seenTurnId: latestTurn?.turnId ?? null,
    announcedRequestIds: new Set(pendingRequestIds(view)),
  };
}

export function advanceSpokenReplies(
  cursor: SpokenReplyCursor | null,
  view: SpokenReplyThreadView,
): SpokenReplyStep {
  if (cursor === null || cursor.threadKey !== view.threadKey) {
    return {
      cursor: baselineSpokenReplyCursor(view),
      utterances: [],
      interrupt: cursor !== null,
    };
  }

  const utterances: SpokenUtterance[] = [];
  let interrupt = false;
  let handledTurnId = cursor.handledTurnId;
  const latestTurn = view.latestTurn;
  const seenTurnId = latestTurn?.turnId ?? cursor.seenTurnId;

  if (latestTurn && latestTurn.turnId !== cursor.seenTurnId) {
    // A new turn exists: whatever was being read is now stale.
    interrupt = true;
  }

  if (latestTurn && latestTurn.turnId !== handledTurnId) {
    switch (latestTurn.state) {
      case "running":
        break;
      case "completed": {
        const markdown = completedTurnMarkdown(view);
        if (markdown !== "pending") {
          if (markdown !== null) {
            utterances.push({ kind: "reply", turnId: latestTurn.turnId, markdown });
          }
          handledTurnId = latestTurn.turnId;
        }
        break;
      }
      case "error":
        utterances.push({
          kind: "error",
          turnId: latestTurn.turnId,
          text: TURN_ERROR_ANNOUNCEMENT,
        });
        handledTurnId = latestTurn.turnId;
        break;
      case "interrupted":
        handledTurnId = latestTurn.turnId;
        break;
    }
  }

  for (const approval of view.pendingApprovals) {
    if (cursor.announcedRequestIds.has(approval.requestId)) continue;
    utterances.push({
      kind: "approval",
      requestId: approval.requestId,
      text: APPROVAL_ANNOUNCEMENTS[approval.requestKind],
    });
  }
  for (const question of view.pendingQuestions) {
    if (cursor.announcedRequestIds.has(question.requestId)) continue;
    utterances.push({
      kind: "question",
      requestId: question.requestId,
      text: questionAnnouncement(question),
    });
  }

  return {
    cursor: {
      threadKey: cursor.threadKey,
      handledTurnId,
      seenTurnId,
      // Resolved requests drop out so the set never grows past what is pending.
      announcedRequestIds: new Set(pendingRequestIds(view)),
    },
    utterances,
    interrupt,
  };
}
