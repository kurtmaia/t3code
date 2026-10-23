import type { SpeechSynthesizeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentHttpConnectionNotReadyError } from "./pullRequests.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import { SpeechSynthesisLoader } from "./speechSynthesisHttp.ts";

export { SpeechSynthesisLoader, speechSynthesisLoaderLayer } from "./speechSynthesisHttp.ts";

/**
 * Speech comes from the thread's environment, which holds the backend
 * address and key, so a clip is requested through that environment's
 * prepared HTTP connection rather than from the client directly.
 */
export function createSpeechEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SpeechSynthesisLoader | R, E>,
) {
  return {
    synthesize: createEnvironmentCommand(runtime, {
      label: "environment-data:speech:synthesize",
      execute: (input: SpeechSynthesizeInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const loader = yield* SpeechSynthesisLoader;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return yield* new EnvironmentHttpConnectionNotReadyError({
              message: "The environment HTTP connection is not ready.",
            });
          }
          return yield* loader.load(prepared.value, input);
        }),
    }),
  };
}
