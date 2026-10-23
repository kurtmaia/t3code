import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Speech synthesis through the environment. The server forwards the text to
 * the OpenAI-compatible backend configured in its settings and streams the
 * audio back, so clients never hold the backend address or key, and a phone
 * on a tunnel hears the same voice as the desktop.
 */

export const SPEECH_SYNTHESIZE_MAX_INPUT_CHARS = 2000;
/** Uncompressed PCM plays everywhere without a decoder and keeps first-audio latency low. */
export const SPEECH_AUDIO_CONTENT_TYPE = "audio/wav";

export const SpeechSynthesizeInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(SPEECH_SYNTHESIZE_MAX_INPUT_CHARS)),
  /** Overrides the environment's configured voice for this request only. */
  voice: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
});
export type SpeechSynthesizeInput = typeof SpeechSynthesizeInput.Type;

export class SpeechBackendNotConfiguredError extends Schema.TaggedErrorClass<SpeechBackendNotConfiguredError>()(
  "SpeechBackendNotConfiguredError",
  {},
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(SpeechBackendNotConfiguredError)(this, { status: 409 });
  }

  override get message(): string {
    return "No text-to-speech backend is configured for this environment.";
  }
}

export class SpeechBackendError extends Schema.TaggedErrorClass<SpeechBackendError>()(
  "SpeechBackendError",
  {
    detail: TrimmedNonEmptyString,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(SpeechBackendError)(this, { status: 502 });
  }

  override get message(): string {
    return `Speech backend request failed: ${this.detail}`;
  }
}
