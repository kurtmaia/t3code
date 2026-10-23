import {
  SpeechBackendError,
  SpeechBackendNotConfiguredError,
  type SpeechSynthesizeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";

/** Time allowed for the backend to start answering; the audio itself then streams. */
const BACKEND_RESPONSE_TIMEOUT = Duration.seconds(45);
const isSpeechBackendError = Schema.is(SpeechBackendError);

/**
 * Forwards text to the OpenAI-compatible speech endpoint from server settings
 * and hands back the audio stream untouched. Which backend answers is the
 * user's business: Kokoro-FastAPI, Speaches, and OpenAI all speak this shape.
 */
export class SpeechSynthesis extends Context.Service<
  SpeechSynthesis,
  {
    readonly synthesize: (
      input: SpeechSynthesizeInput,
    ) => Effect.Effect<
      Stream.Stream<Uint8Array, SpeechBackendError>,
      SpeechBackendNotConfiguredError | SpeechBackendError
    >;
  }
>()("t3/speech/SpeechSynthesis") {}

/** Accepts a bare origin, a `/v1` base, or the full speech path, as users paste all three. */
export function speechEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/audio/speech")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/audio/speech`;
  return `${trimmed}/v1/audio/speech`;
}

function backendRequestError(url: string, cause: unknown): SpeechBackendError {
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new SpeechBackendError({
      detail: `The speech backend at ${url} answered HTTP ${cause.response.status}.`,
      status: cause.response.status,
      cause,
    });
  }
  return new SpeechBackendError({
    detail: `Could not reach the speech backend at ${url}.`,
    cause,
  });
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const synthesize = Effect.fn("speech.synthesize")(function* (input: SpeechSynthesizeInput) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new SpeechBackendError({ detail: "Failed to read server settings.", cause }),
      ),
    );
    const speech = current.speech;
    if (speech.textToSpeechUrl.length === 0) {
      return yield* new SpeechBackendNotConfiguredError();
    }
    const url = speechEndpointUrl(speech.textToSpeechUrl);
    const request = yield* HttpClientRequest.post(url)
      .pipe(
        HttpClientRequest.setHeader("accept", "audio/wav"),
        speech.textToSpeechApiKey.length > 0
          ? HttpClientRequest.bearerToken(speech.textToSpeechApiKey)
          : identity,
        HttpClientRequest.bodyJson({
          model: speech.textToSpeechModel,
          input: input.text,
          voice: input.voice ?? speech.textToSpeechVoice,
          response_format: "wav",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SpeechBackendError({ detail: "Failed to encode the speech request.", cause }),
        ),
      );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeoutOption(BACKEND_RESPONSE_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new SpeechBackendError({
                detail: `The speech backend at ${url} did not answer in time.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.catch((cause) =>
        Effect.fail(isSpeechBackendError(cause) ? cause : backendRequestError(url, cause)),
      ),
    );
    return response.stream.pipe(
      Stream.mapError(
        (cause) =>
          new SpeechBackendError({ detail: "The speech backend stream was interrupted.", cause }),
      ),
    );
  });

  return SpeechSynthesis.of({ synthesize });
});

export const layer = Layer.effect(SpeechSynthesis, make);
