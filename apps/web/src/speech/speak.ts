import type { EnvironmentId } from "@t3tools/contracts";

import { synthesizeSpeechClip } from "../state/speech";
import {
  isCurrentSpeechGeneration,
  nextSpeechGeneration,
  setSpeaking,
  setSpeakingSource,
} from "./speakingState";
import { cancelSystemVoice, speakWithSystemVoice, unlockSystemVoice } from "./speechSynthesis";
import {
  playSynthesizedSpeech,
  stopVoicePlayer,
  unlockVoicePlayer,
  VoicePlaybackError,
} from "./voicePlayer";

export { useIsSpeaking, useSpeakingSource } from "./speakingState";

export interface SpeakOptions {
  /** System voice settings, used directly or as the fallback. */
  readonly voiceURI: string | null;
  readonly rate: number;
  /** When set, the environment's configured speech backend renders the audio. */
  readonly backend: { readonly environmentId: EnvironmentId; readonly voice?: string } | null;
  /** Called once when the backend fails and the system voice takes over. */
  readonly onBackendFailure?: (message: string) => void;
  /** What is being read (a message id, say) so the matching button can offer Stop. */
  readonly sourceId?: string | null;
}

/**
 * The one entry point for saying something. Replaces whatever is speaking.
 * With a backend the audio comes from the environment; if that fails before
 * anything played, the same text goes to the system voice so the user still
 * hears it.
 */
export function speak(text: string, options: SpeakOptions): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  stopSpeaking();
  setSpeakingSource(options.sourceId ?? null);
  if (options.backend === null) {
    speakWithSystemVoice(trimmed, { voiceURI: options.voiceURI, rate: options.rate });
    return;
  }
  const { environmentId, voice } = options.backend;
  void playSynthesizedSpeech(trimmed, (clip) =>
    synthesizeSpeechClip(environmentId, clip, voice),
  ).catch((error: unknown) => {
    const playback = error instanceof VoicePlaybackError ? error : null;
    // A failure from a playback the user already stopped or replaced must
    // neither warn nor speak over whatever replaced it.
    if (playback !== null && !isCurrentSpeechGeneration(playback.generation)) return;
    const detail =
      playback?.cause instanceof Error
        ? playback.cause.message
        : error instanceof Error
          ? error.message
          : String(error);
    options.onBackendFailure?.(detail);
    if (playback === null || playback.playedClips === 0) {
      speakWithSystemVoice(trimmed, { voiceURI: options.voiceURI, rate: options.rate });
    } else {
      setSpeaking(false);
    }
  });
}

export function stopSpeaking(): void {
  nextSpeechGeneration();
  cancelSystemVoice();
  stopVoicePlayer();
  setSpeakingSource(null);
  setSpeaking(false);
}

let armedOnFirstGesture = false;

/**
 * After a reload nothing has been tapped yet, and iOS blocks audio that does
 * not descend from a gesture. The first tap or key press of the page unlocks
 * both renderers so an automatic reply can be heard later.
 */
export function armSpeechOnFirstGesture(): void {
  if (armedOnFirstGesture || typeof document === "undefined") return;
  armedOnFirstGesture = true;
  const unlock = () => {
    document.removeEventListener("pointerup", unlock, true);
    document.removeEventListener("touchend", unlock, true);
    document.removeEventListener("keydown", unlock, true);
    unlockVoicePlayer();
    unlockSystemVoice();
  };
  document.addEventListener("pointerup", unlock, true);
  document.addEventListener("touchend", unlock, true);
  document.addEventListener("keydown", unlock, true);
}
