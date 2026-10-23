import { useSyncExternalStore } from "react";

import { isCurrentSpeechGeneration, nextSpeechGeneration, setSpeaking } from "./speakingState";

/**
 * The browser's own speech synthesis: long text is split into short
 * utterances (Chrome silently stops utterances that run past roughly fifteen
 * seconds) and voices are exposed as a subscribable list. Everything is a
 * no-op where the API is missing.
 */

export const MAX_UTTERANCE_CHARS = 200;

export interface SystemVoiceOptions {
  readonly voiceURI: string | null;
  readonly rate: number;
}

const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+/;

function splitLongSentence(sentence: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = sentence;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const clauseEnd = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
    const wordEnd = window.lastIndexOf(" ");
    const cut =
      clauseEnd >= Math.floor(maxChars / 3) ? clauseEnd + 1 : wordEnd > 0 ? wordEnd : maxChars;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

/** Packs sentences into chunks of at most `maxChars`, never splitting mid-word. */
export function splitUtteranceChunks(text: string, maxChars = MAX_UTTERANCE_CHARS): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of normalized.split(SENTENCE_BOUNDARY)) {
    for (const piece of splitLongSentence(sentence, maxChars)) {
      if (current.length === 0) {
        current = piece;
      } else if (current.length + 1 + piece.length <= maxChars) {
        current = `${current} ${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function getSynth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  const synth = window.speechSynthesis;
  return synth && typeof window.SpeechSynthesisUtterance === "function" ? synth : null;
}

export function isSpeechSynthesisSupported(): boolean {
  return getSynth() !== null;
}

// Chrome drops `end` events for utterances that get garbage collected mid-speech;
// holding the live batch keeps the speaking flag honest.
let liveUtterances: SpeechSynthesisUtterance[] = [];

function resolveVoice(
  synth: SpeechSynthesis,
  voiceURI: string | null,
): SpeechSynthesisVoice | null {
  if (voiceURI === null) return null;
  return synth.getVoices().find((voice) => voice.voiceURI === voiceURI) ?? null;
}

/** Replaces whatever is being said with `text`. Returns false when unsupported or empty. */
export function speakWithSystemVoice(text: string, options: SystemVoiceOptions): boolean {
  const synth = getSynth();
  if (synth === null) return false;
  const chunks = splitUtteranceChunks(text);
  if (chunks.length === 0) return false;

  const batch = nextSpeechGeneration();
  synth.cancel();
  const voice = resolveVoice(synth, options.voiceURI);
  let remaining = chunks.length;
  const settle = () => {
    if (!isCurrentSpeechGeneration(batch)) return;
    remaining -= 1;
    if (remaining === 0) {
      liveUtterances = [];
      setSpeaking(false);
    }
  };
  liveUtterances = chunks.map((chunk) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) utterance.voice = voice;
    utterance.rate = options.rate;
    utterance.addEventListener("end", settle);
    utterance.addEventListener("error", settle);
    return utterance;
  });
  setSpeaking(true);
  for (const utterance of liveUtterances) synth.speak(utterance);
  return true;
}

/** Silences the system voice without touching the shared speaking flag; `speak.ts` owns that. */
export function cancelSystemVoice(): void {
  liveUtterances = [];
  getSynth()?.cancel();
}

// ── Voices ───────────────────────────────────────────────────────────

const EMPTY_VOICES: ReadonlyArray<SpeechSynthesisVoice> = [];
let voicesSnapshot: ReadonlyArray<SpeechSynthesisVoice> = EMPTY_VOICES;
const voiceListeners = new Set<() => void>();
let voicesListening = false;

function refreshVoices(): void {
  const synth = getSynth();
  if (synth === null) return;
  const next = synth.getVoices();
  const changed =
    next.length !== voicesSnapshot.length ||
    next.some((voice, index) => voice.voiceURI !== voicesSnapshot[index]?.voiceURI);
  if (!changed) return;
  voicesSnapshot = next;
  for (const listener of voiceListeners) listener();
}

export function subscribeVoices(listener: () => void): () => void {
  voiceListeners.add(listener);
  const synth = getSynth();
  if (synth !== null && !voicesListening) {
    voicesListening = true;
    synth.addEventListener("voiceschanged", refreshVoices);
  }
  refreshVoices();
  return () => {
    voiceListeners.delete(listener);
  };
}

export function getVoices(): ReadonlyArray<SpeechSynthesisVoice> {
  return voicesSnapshot;
}

/** Voices load asynchronously in Chromium, so the list fills in after mount. */
export function useSpeechVoices(): ReadonlyArray<SpeechSynthesisVoice> {
  return useSyncExternalStore(subscribeVoices, getVoices, () => EMPTY_VOICES);
}

/** The UI language's voices first, each group alphabetical, so the likely pick is near the top. */
export function sortVoicesForLocale(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  locale: string,
): SpeechSynthesisVoice[] {
  const language = locale.toLowerCase().split("-")[0] ?? "";
  const matches = (voice: SpeechSynthesisVoice) =>
    voice.lang.toLowerCase().split(/[-_]/)[0] === language;
  return [...voices].sort((left, right) => {
    const leftMatch = matches(left);
    const rightMatch = matches(right);
    if (leftMatch !== rightMatch) return leftMatch ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
