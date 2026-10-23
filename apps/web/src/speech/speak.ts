import type { EnvironmentId } from "@t3tools/contracts";

import { synthesizeSpeechClip } from "../state/speech";
import { nextSpeechGeneration, setSpeaking } from "./speakingState";
import { cancelSystemVoice, speakWithSystemVoice } from "./speechSynthesis";
import { playSynthesizedSpeech, stopVoicePlayer, VoicePlaybackError } from "./voicePlayer";

export { useIsSpeaking } from "./speakingState";

export interface SpeakOptions {
  /** System voice settings, used directly or as the fallback. */
  readonly voiceURI: string | null;
  readonly rate: number;
  /** When set, the environment's configured speech backend renders the audio. */
  readonly backend: { readonly environmentId: EnvironmentId } | null;
  /** Called once when the backend fails and the system voice takes over. */
  readonly onBackendFailure?: (message: string) => void;
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
  if (options.backend === null) {
    speakWithSystemVoice(trimmed, { voiceURI: options.voiceURI, rate: options.rate });
    return;
  }
  const { environmentId } = options.backend;
  void playSynthesizedSpeech(trimmed, (clip) => synthesizeSpeechClip(environmentId, clip)).catch(
    (error: unknown) => {
      const playback = error instanceof VoicePlaybackError ? error : null;
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
    },
  );
}

export function stopSpeaking(): void {
  nextSpeechGeneration();
  cancelSystemVoice();
  stopVoicePlayer();
  setSpeaking(false);
}
