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
    /** The playback this failure belongs to; stale ones must not trigger fallbacks. */
    readonly generation: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "VoicePlaybackError";
  }
}

let player: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
// Resolves the clip currently awaited by playSynthesizedSpeech; stop calls it
// because pausing an element fires neither "ended" nor "error".
let settleActiveClip: (() => void) | null = null;

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
  // An element that is playing is already unlocked; swapping its source
  // would cut the clip short.
  if (!element.paused) return;
  element.src = silentWavDataUrl();
  void element.play().catch(() => undefined);
}

const RIFF_HEADER_BYTES = 12;
const UNKNOWN_CHUNK_SIZE = 0xffffffff;

/**
 * A server that streams WAV writes the RIFF and data sizes before it knows
 * them, as zero or 0xFFFFFFFF. System players shrug; the browser's audio
 * element refuses the file. With the whole clip in hand the real sizes are
 * known, so fill them in. Returns the input untouched when it is not a WAV
 * or already consistent.
 */
export function finalizeWavHeader(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < RIFF_HEADER_BYTES) return bytes;
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const view = new DataView(copy.buffer);
  let changed = false;
  const riffSize = view.getUint32(4, true);
  if (riffSize === 0 || riffSize === UNKNOWN_CHUNK_SIZE || riffSize > copy.byteLength - 8) {
    view.setUint32(4, copy.byteLength - 8, true);
    changed = true;
  }
  let offset = RIFF_HEADER_BYTES;
  while (offset + 8 <= copy.byteLength) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const remaining = copy.byteLength - offset - 8;
    if (id === "data") {
      if (size === 0 || size === UNKNOWN_CHUNK_SIZE || size > remaining) {
        view.setUint32(offset + 4, remaining, true);
        changed = true;
      }
      break;
    }
    if (size > remaining) break;
    offset += 8 + size + (size % 2);
  }
  return changed ? copy : bytes;
}

function mediaErrorDetail(element: HTMLAudioElement): string {
  const error = element.error;
  if (!error) return "The audio element could not play the clip.";
  const message = error.message.length > 0 ? ` (${error.message})` : "";
  return `The audio element could not play the clip: media error ${error.code}${message}.`;
}

function playBytes(element: HTMLAudioElement, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    releaseObjectUrl();
    // Copy into a plain ArrayBuffer: Blob rejects views over shared memory.
    const finalized = finalizeWavHeader(bytes);
    const copy = new Uint8Array(finalized.byteLength);
    copy.set(finalized);
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: "audio/wav" }));
    activeObjectUrl = url;
    const detach = () => {
      element.removeEventListener("ended", finish);
      element.removeEventListener("error", fail);
      if (settleActiveClip === finish) settleActiveClip = null;
    };
    const finish = () => {
      detach();
      resolve();
    };
    const fail = (cause?: unknown) => {
      detach();
      reject(
        cause instanceof Error
          ? new Error(`${mediaErrorDetail(element)} ${cause.message}`)
          : new Error(mediaErrorDetail(element)),
      );
    };
    // Not "emptied": swapping src on an element that still holds the previous
    // clip fires it immediately, which would end every clip after the first.
    element.addEventListener("ended", finish);
    element.addEventListener("error", fail);
    settleActiveClip = finish;
    element.src = url;
    element.play().catch((cause: unknown) => fail(cause));
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
    throw new VoicePlaybackError(
      "Audio playback is not available here.",
      0,
      nextSpeechGeneration(),
    );
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
        // A playback the user already stopped or replaced fails silently.
        if (!isCurrentSpeechGeneration(batch)) return;
        throw new VoicePlaybackError("The speech backend did not return audio.", played, batch, {
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
        if (!isCurrentSpeechGeneration(batch)) return;
        throw new VoicePlaybackError("The clip could not be played.", played, batch, { cause });
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
  settleActiveClip?.();
  const element = player;
  if (element === null) return;
  element.pause();
  element.removeAttribute("src");
  element.load();
  releaseObjectUrl();
}
