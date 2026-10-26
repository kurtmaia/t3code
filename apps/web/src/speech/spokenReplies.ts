import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveSpeechVoice, toSpeakableText } from "@t3tools/client-runtime/speech";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { getClientSettings, updateClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";
import { readThreadShell } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { speak, stopSpeaking } from "./speak";
import { unlockVoicePlayer } from "./voicePlayer";

export const SPOKEN_REPLIES_ON_CONFIRMATION = "Spoken replies are on.";
export const SPOKEN_REPLIES_SAMPLE = "This is how replies will sound.";

export interface SpeechBackendTarget {
  readonly environmentId: EnvironmentId;
  /** Voice chosen by the environment's per-model rules; undefined means its default voice. */
  readonly voice?: string;
}

/** The environment's speech backend, if it has one configured. */
export function resolveSpeechBackend(
  environmentId: EnvironmentId,
  model?: string | null,
): SpeechBackendTarget | null {
  const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  if (!settings || settings.speech.textToSpeechUrl.length === 0) return null;
  const voice = resolveSpeechVoice(settings.speech.textToSpeechVoiceRules, model);
  return voice === undefined ? { environmentId } : { environmentId, voice };
}

function readThreadModel(threadRef: ScopedThreadRef): string | null {
  return readThreadShell(threadRef)?.modelSelection.model ?? null;
}

/** The primary environment's backend, for surfaces that have no thread in hand. */
export function resolvePrimarySpeechBackend(): SpeechBackendTarget | null {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  return environmentId === null ? null : resolveSpeechBackend(environmentId);
}

/** Whether this device reads the thread aloud: the thread's own choice, else the device default. */
export function isThreadSpokenRepliesEnabled(threadRef: ScopedThreadRef): boolean {
  return (
    useUiStateStore.getState().threadSpokenRepliesById[scopedThreadKey(threadRef)] ??
    getClientSettings().spokenRepliesEnabled
  );
}

/** Per-thread, per-device choice. Turning it on confirms aloud, which also arms audio on iOS. */
export function setThreadSpokenReplies(threadRef: ScopedThreadRef, enabled: boolean): void {
  useUiStateStore.getState().setThreadSpokenReplies(scopedThreadKey(threadRef), enabled);
  // Turning off does not touch current speech here: the open thread's hook
  // stops its own reading when its flag flips, and a thread toggled from the
  // sidebar must not silence a different one.
  if (enabled) {
    speakCurrentVoice(
      SPOKEN_REPLIES_ON_CONFIRMATION,
      resolveSpeechBackend(threadRef.environmentId, readThreadModel(threadRef)),
    );
  }
}

export function toggleThreadSpokenReplies(threadRef: ScopedThreadRef): boolean {
  const enabled = !isThreadSpokenRepliesEnabled(threadRef);
  setThreadSpokenReplies(threadRef, enabled);
  return enabled;
}

/** Reads one message or passage in full, through the environment's backend when it has one. */
export function readAloud(
  environmentId: EnvironmentId | null,
  markdown: string,
  sourceId: string | null = null,
  model: string | null = null,
): void {
  const { text } = toSpeakableText(markdown, { maxChars: Number.POSITIVE_INFINITY });
  if (text.length === 0) return;
  speakCurrentVoice(
    text,
    environmentId === null ? null : resolveSpeechBackend(environmentId, model),
    sourceId,
  );
}

/**
 * Speaks `text` with the user's voice settings. Call from a user gesture:
 * the audio element is unlocked here so iOS lets later clips play on their
 * own.
 */
export function speakCurrentVoice(
  text: string,
  backend: SpeechBackendTarget | null = resolvePrimarySpeechBackend(),
  sourceId: string | null = null,
): void {
  const settings = getClientSettings();
  unlockVoicePlayer();
  speak(text, {
    voiceURI: settings.spokenRepliesVoice,
    rate: settings.spokenRepliesRate,
    backend,
    sourceId,
    onBackendFailure: (message) => {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Neural voice unavailable, using the system voice",
          description:
            backend?.voice === undefined
              ? message
              : `${message} The voice "${backend.voice}" comes from your voice rules; check the server offers it.`,
        }),
      );
    },
  });
}

export function speakSample(backend: SpeechBackendTarget | null): void {
  speakCurrentVoice(SPOKEN_REPLIES_SAMPLE, backend);
}

/**
 * Flips the device default that threads without their own choice follow.
 * Turning it on says so out loud: the confirmation doubles as the
 * user-gesture start that iOS requires before a page may speak on its own.
 */
export function setSpokenRepliesEnabled(enabled: boolean): void {
  updateClientSettings({ spokenRepliesEnabled: enabled });
  if (enabled) {
    speakCurrentVoice(SPOKEN_REPLIES_ON_CONFIRMATION);
  } else {
    stopSpeaking();
  }
}

export function toggleSpokenReplies(): boolean {
  const enabled = !getClientSettings().spokenRepliesEnabled;
  setSpokenRepliesEnabled(enabled);
  return enabled;
}
