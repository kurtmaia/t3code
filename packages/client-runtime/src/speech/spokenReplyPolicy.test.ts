import { describe, expect, it } from "vite-plus/test";

import {
  advanceSpokenReplies,
  baselineSpokenReplyCursor,
  questionAnnouncement,
  TURN_ERROR_ANNOUNCEMENT,
  type SpokenReplyThreadView,
} from "./spokenReplyPolicy.ts";

function view(overrides: Partial<SpokenReplyThreadView> = {}): SpokenReplyThreadView {
  return {
    threadKey: "env:thread-1",
    latestTurn: null,
    messages: [],
    pendingApprovals: [],
    pendingQuestions: [],
    ...overrides,
  };
}

function assistant(id: string, turnId: string, text: string, streaming = false) {
  return { id, role: "assistant", text, streaming, turnId };
}

describe("advanceSpokenReplies", () => {
  it("baselines a newly opened thread without reading its history", () => {
    const opened = view({
      latestTurn: { turnId: "t1", state: "completed", assistantMessageId: "m1" },
      messages: [assistant("m1", "t1", "Old reply")],
      pendingApprovals: [{ requestId: "a1", requestKind: "command" }],
    });
    const step = advanceSpokenReplies(null, opened);
    expect(step.utterances).toEqual([]);
    expect(step.interrupt).toBe(false);
    expect(step.cursor.handledTurnId).toBe("t1");
    expect(step.cursor.announcedRequestIds.has("a1")).toBe(true);
  });

  it("speaks the final assistant message once the turn completes, exactly once", () => {
    const idle = view();
    let cursor = baselineSpokenReplyCursor(idle);

    const running = view({
      latestTurn: { turnId: "t1", state: "running", assistantMessageId: "m1" },
      messages: [assistant("m1", "t1", "Partial", true)],
    });
    let step = advanceSpokenReplies(cursor, running);
    expect(step.utterances).toEqual([]);
    expect(step.interrupt).toBe(true);
    cursor = step.cursor;

    step = advanceSpokenReplies(cursor, running);
    expect(step.interrupt).toBe(false);
    cursor = step.cursor;

    const stillStreaming = view({
      latestTurn: { turnId: "t1", state: "completed", assistantMessageId: "m1" },
      messages: [assistant("m1", "t1", "Full reply", true)],
    });
    step = advanceSpokenReplies(cursor, stillStreaming);
    expect(step.utterances).toEqual([]);
    cursor = step.cursor;

    const completed = view({
      latestTurn: { turnId: "t1", state: "completed", assistantMessageId: "m1" },
      messages: [assistant("m1", "t1", "Full reply")],
    });
    step = advanceSpokenReplies(cursor, completed);
    expect(step.utterances).toEqual([{ kind: "reply", turnId: "t1", markdown: "Full reply" }]);
    cursor = step.cursor;

    step = advanceSpokenReplies(cursor, completed);
    expect(step.utterances).toEqual([]);
  });

  it("speaks a turn that was already running when the thread opened", () => {
    const running = view({
      latestTurn: { turnId: "t1", state: "running", assistantMessageId: null },
    });
    const cursor = baselineSpokenReplyCursor(running);
    const completed = view({
      latestTurn: { turnId: "t1", state: "completed", assistantMessageId: "m1" },
      messages: [assistant("m1", "t1", "Reply")],
    });
    const step = advanceSpokenReplies(cursor, completed);
    expect(step.utterances).toEqual([{ kind: "reply", turnId: "t1", markdown: "Reply" }]);
    expect(step.interrupt).toBe(false);
  });

  it("falls back to the last assistant message of the turn when the id is missing", () => {
    const cursor = baselineSpokenReplyCursor(view());
    const completed = view({
      latestTurn: { turnId: "t1", state: "completed", assistantMessageId: null },
      messages: [assistant("m0", "t0", "Older"), assistant("m1", "t1", "Newest")],
    });
    expect(advanceSpokenReplies(cursor, completed).utterances).toEqual([
      { kind: "reply", turnId: "t1", markdown: "Newest" },
    ]);
  });

  it("stays quiet for interrupted turns and announces errors", () => {
    const cursor = baselineSpokenReplyCursor(view());
    const interrupted = view({
      latestTurn: { turnId: "t1", state: "interrupted", assistantMessageId: null },
    });
    const afterInterrupt = advanceSpokenReplies(cursor, interrupted);
    expect(afterInterrupt.utterances).toEqual([]);
    expect(afterInterrupt.cursor.handledTurnId).toBe("t1");

    const errored = view({
      latestTurn: { turnId: "t2", state: "error", assistantMessageId: null },
    });
    expect(advanceSpokenReplies(afterInterrupt.cursor, errored).utterances).toEqual([
      { kind: "error", turnId: "t2", text: TURN_ERROR_ANNOUNCEMENT },
    ]);
  });

  it("announces approvals and questions the first time they appear", () => {
    let cursor = baselineSpokenReplyCursor(view());
    const asking = view({
      latestTurn: { turnId: "t1", state: "running", assistantMessageId: null },
      pendingApprovals: [{ requestId: "a1", requestKind: "file-change" }],
      pendingQuestions: [
        { requestId: "q1", header: "Database", question: "Which database should I use?" },
      ],
    });
    let step = advanceSpokenReplies(cursor, asking);
    expect(step.utterances).toEqual([
      {
        kind: "approval",
        requestId: "a1",
        text: "The agent is asking for approval to change a file.",
      },
      {
        kind: "question",
        requestId: "q1",
        text: "The agent has a question. Database. Which database should I use?",
      },
    ]);
    cursor = step.cursor;

    step = advanceSpokenReplies(cursor, asking);
    expect(step.utterances).toEqual([]);
    cursor = step.cursor;

    const resolved = view({
      latestTurn: { turnId: "t1", state: "running", assistantMessageId: null },
    });
    cursor = advanceSpokenReplies(cursor, resolved).cursor;
    expect(cursor.announcedRequestIds.size).toBe(0);

    // The same request id coming back after resolution is news again.
    expect(advanceSpokenReplies(cursor, asking).utterances).toHaveLength(2);
  });

  it("interrupts and re-baselines when the shown thread changes", () => {
    const first = view({ threadKey: "env:a" });
    const cursor = baselineSpokenReplyCursor(first);
    const second = view({
      threadKey: "env:b",
      latestTurn: { turnId: "t9", state: "completed", assistantMessageId: "m9" },
      messages: [assistant("m9", "t9", "Other thread reply")],
    });
    const step = advanceSpokenReplies(cursor, second);
    expect(step.interrupt).toBe(true);
    expect(step.utterances).toEqual([]);
    expect(step.cursor.threadKey).toBe("env:b");
    expect(step.cursor.handledTurnId).toBe("t9");
  });
});

describe("questionAnnouncement", () => {
  it("trims long questions at a word boundary", () => {
    const long = "word ".repeat(100).trim();
    const text = questionAnnouncement({ header: "", question: long });
    expect(text.startsWith("The agent has a question. word")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(320);
  });
});
