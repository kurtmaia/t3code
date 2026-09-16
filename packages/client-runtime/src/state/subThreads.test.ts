import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  THREAD_SOURCE_QUOTE_MAX_LENGTH,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSubThreadCreation,
  buildSubThreadSeedPrompt,
  buildSubThreadTitle,
  partitionThreadShellsByParent,
  selectSubThreadAnchors,
  subThreadQuoteSnippet,
  truncateQuote,
} from "./subThreads.ts";

const PARENT_ID = ThreadId.make("thread-parent");
const MESSAGE_ID = MessageId.make("message-1");

function makeShell(
  overrides: Partial<OrchestrationThreadShell> & Pick<OrchestrationThreadShell, "id">,
): OrchestrationThreadShell {
  return {
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("truncateQuote", () => {
  it("keeps short quotes verbatim", () => {
    expect(truncateQuote("  a short quote  ")).toBe("a short quote");
  });

  it("caps long quotes at the contract bound on a word boundary", () => {
    const quote = truncateQuote(`${"word ".repeat(200)}end`);
    expect(quote.length).toBeLessThanOrEqual(THREAD_SOURCE_QUOTE_MAX_LENGTH);
    expect(quote.endsWith("…")).toBe(true);
    expect(quote).not.toContain("  ");
  });
});

describe("subThreadQuoteSnippet / buildSubThreadTitle", () => {
  it("collapses whitespace into a single-line snippet", () => {
    expect(subThreadQuoteSnippet("uses\n  two   lines")).toBe("uses two lines");
  });

  it("titles from the snippet with a fallback for empty quotes", () => {
    expect(buildSubThreadTitle("the exact point")).toBe("Re: the exact point");
    expect(buildSubThreadTitle("   ")).toBe("Side conversation");
  });
});

describe("buildSubThreadSeedPrompt", () => {
  it("blockquotes every quoted line ahead of the question", () => {
    const prompt = buildSubThreadSeedPrompt({
      quoteText: "first line\nsecond line",
      question: "Why is this true?",
    });
    expect(prompt).toContain("> first line\n> second line");
    expect(prompt.endsWith("Why is this true?")).toBe(true);
  });
});

describe("buildSubThreadCreation", () => {
  it("joins the parent worktree in plan mode with a replaceable title", () => {
    const { createInput, startInput } = buildSubThreadCreation({
      threadId: ThreadId.make("thread-sub"),
      messageId: MessageId.make("message-user-1"),
      parent: {
        id: PARENT_ID,
        projectId: ProjectId.make("project-1"),
        branch: "t3code/feature",
        worktreePath: "/tmp/worktree",
        taskId: null,
      },
      quote: { messageId: MESSAGE_ID, text: "the exact point" },
      promptText: "formatted prompt",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(createInput.parentThreadId).toBe(PARENT_ID);
    expect(createInput.sourceQuote?.messageId).toBe(MESSAGE_ID);
    expect(createInput.interactionMode).toBe("plan");
    expect(createInput.branch).toBe("t3code/feature");
    expect(createInput.worktreePath).toBe("/tmp/worktree");
    expect(createInput.title).toBe("Re: the exact point");
    // titleSeed matches the pre-set title so auto-titling may replace it.
    expect(startInput.titleSeed).toBe(createInput.title);
    expect(startInput.interactionMode).toBe("plan");
    expect(startInput.message.text).toBe("formatted prompt");
  });
});

describe("selectSubThreadAnchors", () => {
  it("groups anchors by parent thread and quoted message", () => {
    const anchors = selectSubThreadAnchors([
      makeShell({ id: PARENT_ID }),
      makeShell({
        id: ThreadId.make("thread-sub-1"),
        parentThreadId: PARENT_ID,
        sourceQuote: { messageId: MESSAGE_ID, text: "quote one" },
      }),
      makeShell({
        id: ThreadId.make("thread-sub-2"),
        parentThreadId: PARENT_ID,
        sourceQuote: { messageId: MESSAGE_ID, text: "quote two" },
      }),
      makeShell({ id: ThreadId.make("thread-unrelated") }),
    ]);

    const byMessage = anchors.get(PARENT_ID);
    expect(byMessage?.get(MESSAGE_ID)?.map((anchor) => anchor.quoteText)).toEqual([
      "quote one",
      "quote two",
    ]);
    expect(anchors.has(ThreadId.make("thread-unrelated"))).toBe(false);
  });
});

describe("partitionThreadShellsByParent", () => {
  it("nests children under present parents and promotes orphans", () => {
    const parent = makeShell({ id: PARENT_ID });
    const child = makeShell({
      id: ThreadId.make("thread-sub-1"),
      parentThreadId: PARENT_ID,
      sourceQuote: { messageId: MESSAGE_ID, text: "quote" },
    });
    const orphan = makeShell({
      id: ThreadId.make("thread-orphan"),
      parentThreadId: ThreadId.make("thread-gone"),
      sourceQuote: { messageId: MESSAGE_ID, text: "quote" },
    });

    const { topLevel, childrenByParent } = partitionThreadShellsByParent([parent, child, orphan]);
    expect(topLevel.map((shell) => shell.id)).toEqual([PARENT_ID, ThreadId.make("thread-orphan")]);
    expect(childrenByParent.get(PARENT_ID)?.map((shell) => shell.id)).toEqual([
      ThreadId.make("thread-sub-1"),
    ]);
  });
});
