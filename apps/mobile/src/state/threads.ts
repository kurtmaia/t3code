import { useAtomValue } from "@effect/atom-react";
import {
  selectSubThreadAnchors,
  type SubThreadAnchor,
} from "@t3tools/client-runtime/state/subThreads";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export type SubThreadAnchorsByMessage = ReadonlyMap<
  ThreadId,
  ReadonlyMap<MessageId, ReadonlyArray<SubThreadAnchor>>
>;

const EMPTY_SUB_THREAD_ANCHORS: SubThreadAnchorsByMessage = new Map();

/** Anchor content is write-once (`parentThreadId`/`sourceQuote` are set at
    creation), so two derivations are equal iff they mention the same
    sub-thread ids under the same parent/message keys. */
function subThreadAnchorsEqual(
  previous: SubThreadAnchorsByMessage,
  next: SubThreadAnchorsByMessage,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [parentThreadId, previousByMessage] of previous) {
    const nextByMessage = next.get(parentThreadId);
    if (nextByMessage === undefined || nextByMessage.size !== previousByMessage.size) return false;
    for (const [messageId, previousAnchors] of previousByMessage) {
      const nextAnchors = nextByMessage.get(messageId);
      if (nextAnchors === undefined || nextAnchors.length !== previousAnchors.length) return false;
      for (let index = 0; index < previousAnchors.length; index += 1) {
        if (previousAnchors[index]?.threadId !== nextAnchors[index]?.threadId) return false;
      }
    }
  }
  return true;
}

/**
 * Per-environment quote anchors (parent thread → message → sub-threads).
 * Shell churn (session status, streaming) re-derives cheaply, but the atom
 * only publishes when a sub-thread appears or disappears, so subscribers —
 * the thread transcript — do not re-render on unrelated shell updates.
 */
const subThreadAnchorsAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous = EMPTY_SUB_THREAD_ANCHORS;
  return Atom.make((get): SubThreadAnchorsByMessage => {
    const next = selectSubThreadAnchors(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)),
    );
    if (next.size === 0) {
      previous = EMPTY_SUB_THREAD_ANCHORS;
      return previous;
    }
    if (subThreadAnchorsEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return previous;
  }).pipe(Atom.withLabel(`mobile-sub-thread-anchors:${environmentId}`));
});

/** Anchors for one parent thread, keyed by message id; null when it has none. */
export function useSubThreadAnchors(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyMap<MessageId, ReadonlyArray<SubThreadAnchor>> | null {
  return useAtomValue(subThreadAnchorsAtom(environmentId)).get(threadId) ?? null;
}

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}
