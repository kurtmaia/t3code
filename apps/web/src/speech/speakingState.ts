import { useSyncExternalStore } from "react";

/**
 * One "is something speaking" flag shared by the system voice and backend
 * playback, plus a generation counter so a stale completion callback from a
 * cancelled utterance can never flip the flag for the one that replaced it.
 */

let speaking = false;
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
