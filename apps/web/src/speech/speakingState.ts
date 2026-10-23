import { useSyncExternalStore } from "react";

/**
 * One "is something speaking" flag shared by the system voice and backend
 * playback, plus a generation counter so a stale completion callback from a
 * cancelled utterance can never flip the flag for the one that replaced it.
 */

let speaking = false;
/** What is being read, e.g. a message id, so a per-message button can show Stop for itself only. */
let speakingSourceId: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();

export function setSpeaking(next: boolean): void {
  if (speaking === next) return;
  speaking = next;
  for (const listener of listeners) listener();
}

export function isSpeaking(): boolean {
  return speaking;
}

export function setSpeakingSource(sourceId: string | null): void {
  if (speakingSourceId === sourceId) return;
  speakingSourceId = sourceId;
  for (const listener of listeners) listener();
}

export function getSpeakingSource(): string | null {
  return speakingSourceId;
}

export function useSpeakingSource(): string | null {
  return useSyncExternalStore(subscribeSpeaking, getSpeakingSource, () => null);
}

export function subscribeSpeaking(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useIsSpeaking(): boolean {
  return useSyncExternalStore(subscribeSpeaking, isSpeaking, () => false);
}

/** Claims the floor: whatever was speaking before is now stale. */
export function nextSpeechGeneration(): number {
  generation += 1;
  return generation;
}

export function isCurrentSpeechGeneration(candidate: number): boolean {
  return candidate === generation;
}
