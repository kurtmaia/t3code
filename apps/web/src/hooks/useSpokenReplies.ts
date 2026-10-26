import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import {
  advanceSpokenReplies,
  resolveSpeechVoice,
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
const selectVoiceRules = (settings: UnifiedSettings) => settings.speech.textToSpeechVoiceRules;

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
  const voiceRules = useEnvironmentSettings(
    environmentId ?? FALLBACK_ENVIRONMENT_ID,
    selectVoiceRules,
  );
  const model = input.thread?.modelSelection.model ?? null;
  const backend = useMemo(() => {
    if (environmentId === null || backendUrl.length === 0) return null;
    const voice = resolveSpeechVoice(voiceRules, model);
    return voice === undefined ? { environmentId } : { environmentId, voice };
  }, [backendUrl, environmentId, model, voiceRules]);
  const cursorRef = useRef<SpokenReplyCursor | null>(null);
  const shownThreadKeyRef = useRef<string | null>(null);
  const latestTurn = input.thread?.latestTurn ?? null;
  const messages = input.thread?.messages ?? null;

  // One warning per session per voice: a backend outage should not toast on
  // every reply, but a misspelled voice in the rules must still get named.
  const warnedVoicesRef = useRef<Set<string>>(new Set());
  const ruleVoice = backend?.voice ?? null;
  const onBackendFailure = useCallback(
    (message: string) => {
      const key = ruleVoice ?? "";
      if (warnedVoicesRef.current.has(key)) return;
      warnedVoicesRef.current.add(key);
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Neural voice unavailable, using the system voice",
          description:
            ruleVoice === null
              ? message
              : `${message} The voice "${ruleVoice}" comes from your voice rules; check the server offers it.`,
        }),
      );
    },
    [ruleVoice],
  );

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
    // Leaving a thread silences it at once, even when the next thread's
    // detail has not arrived yet and the policy has nothing to step over.
    if (shownThreadKeyRef.current !== input.threadKey) {
      if (shownThreadKeyRef.current !== null) stopSpeaking();
      shownThreadKeyRef.current = input.threadKey;
    }
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
  }, [backend, enabled, input.threadKey, onBackendFailure, rate, view, voiceURI]);

  useEffect(() => {
    if (enabled) {
      armSpeechOnFirstGesture();
    } else {
      stopSpeaking();
    }
  }, [enabled]);

  return useIsSpeaking();
}
