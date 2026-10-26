import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createSpeechEnvironmentAtoms } from "@t3tools/client-runtime/state/speech";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./query";

export const speechEnvironment = createSpeechEnvironmentAtoms(connectionAtomRuntime);

/** One clip of audio from the environment's speech backend; rejects with a readable message. */
export async function synthesizeSpeechClip(
  environmentId: EnvironmentId,
  text: string,
  voice?: string,
): Promise<Uint8Array> {
  const result = await runAtomCommand(
    appAtomRegistry,
    speechEnvironment.synthesize,
    { environmentId, input: voice === undefined ? { text } : { text, voice } },
    { label: "speech:synthesize", reportFailure: false, reportDefect: false },
  );
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  throw new Error(formatEnvironmentQueryError(result.cause));
}
