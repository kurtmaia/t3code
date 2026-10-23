import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import {
  advanceSpokenReplies,
  toSpeakableText,
  type SpokenReplyCursor,
  type SpokenReplyThreadView,
} from "@t3tools/client-runtime/speech";
import {
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { PendingApproval, PendingUserInput } from "../session-logic";
import { armSpeechOnFirstGesture, speak, stopSpeaking, useIsSpeaking } from "../speech/speak";
import { useClientSettings, useEnvironmentSettings } from "./useSettings";

const selectVoice = (settings: { spokenRepliesVoice: string | null }) =>
  settings.spokenRepliesVoice;
const selectRate = (settings: { spokenRepliesRate: number }) => settings.spokenRepliesRate;
const selectBackendUrl = (settings: UnifiedSettings) => settings.speech.textToSpeechUrl;

const FALLBACK_ENVIRONMENT_ID = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);

/**
 * Reads the open thread's replies aloud while `enabled` (the thread's own
 * choice on this device, else the device default). The policy cursor is kept
 * current even while off, so turning it on mid-conversation never replays
 * what is already on screen. Audio comes from the thread's environment when
 * it has a speech backend, otherwise from this device's system voice.
 */
export function useSpokenReplies(input: {
  readonly enabled: boolean;
  readonly thread: EnvironmentThread | null;
  readonly threadKey: string | null;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
}): boolean {
  const enabled = input.enabled;
  const voiceURI = useClientSettings(selectVoice);
  const rate = useClientSettings(selectRate);
  const environmentId = input.thread?.environmentId ?? null;
  const backendUrl = useEnvironmentSettings(
    environmentId ?? FALLBACK_ENVIRONMENT_ID,
    selectBackendUrl,
  );
  const backend = useMemo(
    () => (environmentId !== null && backendUrl.length > 0 ? { environmentId } : null),
    [backendUrl, environmentId],
  );
  const cursorRef = useRef<SpokenReplyCursor | null>(null);
  const warnedBackendRef = useRef(false);
  const latestTurn = input.thread?.latestTurn ?? null;
  const messages = input.thread?.messages ?? null;

  // One warning per session: a backend outage should not toast on every reply.
  const onBackendFailure = useCallback((message: string) => {
    if (warnedBackendRef.current) return;
    warnedBackendRef.current = true;
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Neural voice unavailable, using the system voice",
        description: message,
      }),
    );
  }, []);

  const view = useMemo<SpokenReplyThreadView | null>(() => {
    if (input.threadKey === null || messages === null) return null;
    return {
      threadKey: input.threadKey,
      latestTurn: latestTurn
        ? {
            turnId: latestTurn.turnId,
            state: latestTurn.state,
            assistantMessageId: latestTurn.assistantMessageId,
          }
        : null,
      messages,
      pendingApprovals: input.pendingApprovals,
      pendingQuestions: input.pendingUserInputs.map((request) => {
        const first = request.questions[0];
        return {
          requestId: request.requestId,
          header: first?.header ?? "",
          question: first?.question ?? "",
        };
      }),
    };
  }, [input.pendingApprovals, input.pendingUserInputs, input.threadKey, latestTurn, messages]);

  useEffect(() => {
    if (view === null) {
      cursorRef.current = null;
      return;
    }
    const step = advanceSpokenReplies(cursorRef.current, view);
    cursorRef.current = step.cursor;
    if (!enabled) return;
    if (step.interrupt) stopSpeaking();
    if (step.utterances.length === 0) return;
    const text = step.utterances
      .map((utterance) =>
        utterance.kind === "reply" ? toSpeakableText(utterance.markdown).text : utterance.text,
      )
      .filter((part) => part.length > 0)
      .join(" ");
    if (text.length > 0) speak(text, { voiceURI, rate, backend, onBackendFailure });
  }, [backend, enabled, onBackendFailure, rate, view, voiceURI]);

  useEffect(() => {
    if (enabled) {
      armSpeechOnFirstGesture();
    } else {
      stopSpeaking();
    }
  }, [enabled]);

  return useIsSpeaking();
}
