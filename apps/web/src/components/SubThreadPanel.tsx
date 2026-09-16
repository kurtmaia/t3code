/**
 * Sub-thread right-panel surface: a side conversation anchored to a quoted
 * passage of the parent thread's transcript.
 *
 * Deliberately lighter than ChatView's composer: a sub-thread is a focused
 * Q&A next to the text it is about. It inherits the parent's worktree and
 * model and interaction mode (switchable), and anything heavier — approvals,
 * attachments, model changes — belongs in "Open as full thread".
 *
 * While the surface is a draft (`subThreadId === null`) nothing exists on the
 * server; the thread is created on first send, mirroring the
 * implement-plan-in-new-thread flow, and rolled back if the first turn fails.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildSubThreadCreation,
  buildSubThreadSeedPrompt,
  truncateQuote,
} from "@t3tools/client-runtime/state/subThreads";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  MessageId,
  OrchestrationThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, ExternalLink, MessageSquareQuote, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { newMessageId, newThreadId } from "~/lib/utils";
import { useThread } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { waitForStartedServerThread } from "./ChatView.logic";
import type { SubThreadSurface } from "~/rightPanelStore";

interface SubThreadPanelProps {
  parentThreadRef: ScopedThreadRef;
  parentShell: OrchestrationThreadShell;
  surface: SubThreadSurface;
  /** The parent thread's working directory, for markdown link/path rendering. */
  cwd: string | undefined;
  onPromoteDraft: (draftSurfaceId: string, subThreadId: string) => void;
  onCloseSurface: (surfaceId: string) => void;
}

const SCROLL_STICKY_THRESHOLD_PX = 80;

type AtomCommandFailure = Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>;

export function SubThreadPanel(props: SubThreadPanelProps) {
  const { parentThreadRef, parentShell, surface, cwd } = props;
  const environmentId = parentThreadRef.environmentId;
  const navigate = useNavigate();

  const subThreadRef =
    surface.subThreadId === null
      ? null
      : scopeThreadRef(environmentId, surface.subThreadId as ThreadId);
  const subThread = useThread(subThreadRef, { waitForShell: true });

  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });

  const [draftText, setDraftText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const sendInFlightRef = useRef(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToEndRef = useRef(true);
  const messages = subThread?.messages ?? [];
  const lastMessage = messages.at(-1);
  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickToEndRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, lastMessage?.text]);

  const turnRunning = subThread?.session?.activeTurnId != null || lastMessage?.streaming === true;
  const interactionMode = subThread?.interactionMode ?? parentShell.interactionMode;

  const reportSendFailure = useCallback((failure: AtomCommandFailure) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not send to side conversation",
        description:
          error instanceof Error ? error.message : "An error occurred while sending the message.",
      }),
    );
  }, []);

  const onSend = useCallback(async () => {
    const question = draftText.trim();
    if (question.length === 0 || sendInFlightRef.current || turnRunning) {
      return;
    }
    sendInFlightRef.current = true;
    setIsSending(true);
    const finish = () => {
      sendInFlightRef.current = false;
      setIsSending(false);
    };

    // Follow-up on an existing sub-thread.
    if (surface.subThreadId !== null && subThread) {
      const result = await startThreadTurn({
        environmentId,
        input: {
          threadId: subThread.id,
          message: { messageId: newMessageId(), role: "user", text: question, attachments: [] },
          modelSelection: subThread.modelSelection,
          runtimeMode: subThread.runtimeMode,
          interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        reportSendFailure(result);
      } else {
        setDraftText("");
      }
      finish();
      return;
    }

    // First send: create the sub-thread, then its first turn, then swap the
    // draft tab for the thread-backed one. Roll back on any failure so a
    // failed question never leaves an empty thread behind.
    const nextThreadId = newThreadId();
    const quote = {
      messageId: surface.parentMessageId as MessageId,
      text: truncateQuote(surface.quoteText),
    };
    const { createInput, startInput } = buildSubThreadCreation({
      threadId: nextThreadId,
      messageId: newMessageId(),
      parent: parentShell,
      quote,
      promptText: buildSubThreadSeedPrompt({ quoteText: quote.text, question }),
      modelSelection: parentShell.modelSelection,
      runtimeMode: parentShell.runtimeMode,
      interactionMode: parentShell.interactionMode,
      createdAt: new Date().toISOString(),
    });

    const createResult = await createThread({ environmentId, input: createInput });
    let failure: AtomCommandFailure | null = createResult._tag === "Failure" ? createResult : null;
    if (failure === null) {
      const startResult = await startThreadTurn({ environmentId, input: startInput });
      failure = startResult._tag === "Failure" ? startResult : null;
    }
    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }
    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: { threadId: nextThreadId },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up sub-thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      reportSendFailure(failure);
      finish();
      return;
    }
    setDraftText("");
    props.onPromoteDraft(surface.id, nextThreadId);
    finish();
  }, [
    createThread,
    deleteThread,
    draftText,
    environmentId,
    interactionMode,
    parentShell,
    props,
    reportSendFailure,
    startThreadTurn,
    subThread,
    surface,
    turnRunning,
  ]);

  const onToggleInteractionMode = useCallback(() => {
    if (!subThread) return;
    void setThreadInteractionMode({
      environmentId,
      input: {
        threadId: subThread.id,
        interactionMode: interactionMode === "plan" ? "default" : "plan",
        createdAt: new Date().toISOString(),
      },
    });
  }, [environmentId, interactionMode, setThreadInteractionMode, subThread]);

  const onInterrupt = useCallback(() => {
    if (!subThread) return;
    void interruptThreadTurn({
      environmentId,
      input: { threadId: subThread.id, createdAt: new Date().toISOString() },
    });
  }, [environmentId, interruptThreadTurn, subThread]);

  const onOpenAsFullThread = useCallback(() => {
    if (surface.subThreadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: surface.subThreadId },
    });
  }, [environmentId, navigate, surface.subThreadId]);

  // Deleted while open: the shell is gone but the tab is still here.
  const subThreadMissing =
    surface.subThreadId !== null && subThreadRef !== null && subThread === null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <MessageSquareQuote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <blockquote className="line-clamp-3 min-w-0 flex-1 text-xs text-muted-foreground italic">
          {surface.quoteText}
        </blockquote>
        {surface.subThreadId !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label="Open as full thread"
                  onClick={onOpenAsFullThread}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup>Open as full thread</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      {subThreadMissing ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-sm text-muted-foreground">This side conversation was deleted.</p>
          <Button variant="outline" size="sm" onClick={() => props.onCloseSurface(surface.id)}>
            Close
          </Button>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            stickToEndRef.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < SCROLL_STICKY_THRESHOLD_PX;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        >
          {surface.subThreadId === null ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Ask about the highlighted passage. The side conversation uses this thread&apos;s mode
              and workspace.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((message) =>
                message.role === "user" ? (
                  <div
                    key={message.id}
                    className="ml-6 rounded-lg bg-muted/60 px-3 py-2 text-sm whitespace-pre-wrap"
                  >
                    {message.text}
                  </div>
                ) : (
                  <div key={message.id} className="text-sm">
                    <ChatMarkdown text={message.text} cwd={cwd} isStreaming={message.streaming} />
                  </div>
                ),
              )}
              {turnRunning && lastMessage?.streaming !== true ? (
                <p className="text-xs text-muted-foreground">Working…</p>
              ) : null}
            </div>
          )}
        </div>
      )}

      {subThreadMissing ? null : (
        <div className="border-t p-2">
          <textarea
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSend();
              }
            }}
            rows={2}
            placeholder={
              surface.subThreadId === null
                ? "Ask about this passage…"
                : "Reply in this side conversation…"
            }
            className="w-full resize-none rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="mt-1 flex items-center justify-between">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onToggleInteractionMode}
                    disabled={subThread === null}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors",
                      interactionMode === "plan"
                        ? "border-border"
                        : "border-amber-500/50 text-amber-600 dark:text-amber-400",
                      subThread === null && "opacity-50",
                    )}
                  >
                    {interactionMode === "plan" ? "Plan" : "Edit"}
                  </button>
                }
              />
              <TooltipPopup>
                {interactionMode === "plan"
                  ? "Plan mode: answers without editing files. Click to allow edits."
                  : "Edit mode: the agent may change files in the shared workspace. Click for plan mode."}
              </TooltipPopup>
            </Tooltip>
            {turnRunning ? (
              <Button variant="outline" size="icon-sm" aria-label="Stop" onClick={onInterrupt}>
                <Square className="size-3" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                aria-label="Send"
                disabled={draftText.trim().length === 0 || isSending}
                onClick={() => void onSend()}
              >
                <ArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
