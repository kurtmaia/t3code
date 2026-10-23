import { isCurrentSpeechGeneration, nextSpeechGeneration, setSpeaking } from "./speakingState";
import { splitUtteranceChunks } from "./speechSynthesis";

/**
 * Plays audio produced by the environment's speech backend. Text is cut into
 * sentence-sized clips, the next clip is requested while the current one
 * plays, and the first clip starts as soon as it lands, so a long reply does
 * not wait on the whole synthesis.
 */

/** Long enough to keep requests few, short enough that the first clip lands in about a second. */
export const VOICE_CLIP_MAX_CHARS = 300;

export class VoicePlaybackError extends Error {
  constructor(
    message: string,
    readonly playedClips: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "VoicePlaybackError";
  }
}

let player: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;

function getPlayer(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (player === null) {
    player = new Audio();
    player.preload = "auto";
  }
  return player;
}

function releaseObjectUrl(): void {
  if (activeObjectUrl !== null) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
}

// 44-byte header plus two bytes of silence: the smallest thing an <audio> will play.
function silentWavDataUrl(): string {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 38, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, 2, true);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/**
 * iOS only lets an audio element start inside a tap. Playing a silent clip
 * from the gesture that turns spoken replies on keeps the element usable
 * for clips that arrive later from the network.
 */
export function unlockVoicePlayer(): void {
  const element = getPlayer();
  if (element === null) return;
  element.src = silentWavDataUrl();
  void element.play().catch(() => undefined);
}

function playBytes(element: HTMLAudioElement, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    releaseObjectUrl();
    // Copy into a plain ArrayBuffer: Blob rejects views over shared memory.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: "audio/wav" }));
    activeObjectUrl = url;
    const finish = () => {
      element.removeEventListener("ended", finish);
      element.removeEventListener("error", fail);
      element.removeEventListener("emptied", finish);
      resolve();
    };
    const fail = () => {
      element.removeEventListener("ended", finish);
      element.removeEventListener("error", fail);
      element.removeEventListener("emptied", finish);
      reject(new Error("The audio element could not play the clip."));
    };
    element.addEventListener("ended", finish);
    element.addEventListener("error", fail);
    // stopVoicePlayer() clears the source, which fires "emptied".
    element.addEventListener("emptied", finish);
    element.src = url;
    element.play().catch(fail);
  });
}

/**
 * Speaks `text` through `synthesize`, one clip at a time. Resolves when the
 * last clip ends or playback was replaced; rejects with `VoicePlaybackError`
 * when a clip could not be fetched or played, saying how many clips played.
 */
export async function playSynthesizedSpeech(
  text: string,
  synthesize: (clip: string) => Promise<Uint8Array>,
): Promise<void> {
  const element = getPlayer();
  if (element === null) {
    throw new VoicePlaybackError("Audio playback is not available here.", 0);
  }
  const clips = splitUtteranceChunks(text, VOICE_CLIP_MAX_CHARS);
  if (clips.length === 0) return;

  const batch = nextSpeechGeneration();
  setSpeaking(true);
  let played = 0;
  try {
    let pending: Promise<Uint8Array> | null = synthesize(clips[0]!);
    for (let index = 0; index < clips.length; index += 1) {
      let bytes: Uint8Array;
      try {
        bytes = await pending!;
      } catch (cause) {
        throw new VoicePlaybackError("The speech backend did not return audio.", played, {
          cause,
        });
      }
      if (!isCurrentSpeechGeneration(batch)) return;
      const next = clips[index + 1];
      pending = next === undefined ? null : synthesize(next);
      // A prefetch that fails is reported when its turn comes, not as an unhandled rejection.
      pending?.catch(() => undefined);
      try {
        await playBytes(element, bytes);
      } catch (cause) {
        throw new VoicePlaybackError("The clip could not be played.", played, { cause });
      }
      if (!isCurrentSpeechGeneration(batch)) return;
      played += 1;
    }
  } finally {
    if (isCurrentSpeechGeneration(batch)) {
      releaseObjectUrl();
      setSpeaking(false);
    }
  }
}

/** Stops backend playback without touching the shared speaking flag; `speak.ts` owns that. */
export function stopVoicePlayer(): void {
  const element = player;
  if (element === null) return;
  element.pause();
  element.removeAttribute("src");
  element.load();
  releaseObjectUrl();
}
