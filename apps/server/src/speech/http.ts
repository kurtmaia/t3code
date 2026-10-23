import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { SpeechSynthesis } from "./SpeechSynthesis.ts";

/** Streams backend audio to the client; the payload is text, the response is bytes. */
export const speechHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "speech",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechSynthesis;
    return handlers.handle(
      "synthesize",
      Effect.fn("environment.speech.synthesize")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* speech.synthesize(args.payload);
      }),
    );
  }),
);
