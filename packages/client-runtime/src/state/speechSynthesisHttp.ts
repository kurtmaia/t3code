import type { SpeechSynthesizeInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_SPEECH_SYNTHESIS_TIMEOUT_MS = 60_000;

function concatChunks(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One clip per call; the caller chunks long text so playback can start early. */
export const fetchEnvironmentSpeech = Effect.fn("clientRuntime.state.fetchEnvironmentSpeech")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly input: SpeechSynthesizeInput;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly timeoutMs?: number;
  }) {
    const requestUrl = makeEnvironmentHttpApiUrlBuilder(
      input.prepared.httpBaseUrl,
    ).speech.synthesize();
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      requestUrl,
      input.signer,
    );
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs ?? DEFAULT_SPEECH_SYNTHESIS_TIMEOUT_MS,
      withEnvironmentCredentials(
        input.prepared.httpAuthorization,
        client.speech.synthesize({ payload: input.input, headers }),
      ).pipe(
        Effect.flatMap((stream) => Stream.runCollect(stream)),
        Effect.map(concatChunks),
      ),
    );
  },
);

export class SpeechSynthesisLoader extends Context.Service<
  SpeechSynthesisLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      input: SpeechSynthesizeInput,
    ) => Effect.Effect<Uint8Array, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/speechSynthesisHttp/SpeechSynthesisLoader") {}

export const speechSynthesisLoaderLayer: Layer.Layer<
  SpeechSynthesisLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  SpeechSynthesisLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return SpeechSynthesisLoader.of({
      load: (prepared, input) =>
        fetchEnvironmentSpeech({ prepared, input, signer }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
