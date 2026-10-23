import type { SpeechBackendError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { SpeechSynthesis, layer, speechEndpointUrl } from "./SpeechSynthesis.ts";

describe("speechEndpointUrl", () => {
  it("accepts an origin, a /v1 base, or the full path", () => {
    expect(speechEndpointUrl("http://mini:8890")).toBe("http://mini:8890/v1/audio/speech");
    expect(speechEndpointUrl("http://mini:8890/")).toBe("http://mini:8890/v1/audio/speech");
    expect(speechEndpointUrl("http://mini:8890/v1")).toBe("http://mini:8890/v1/audio/speech");
    expect(speechEndpointUrl("http://mini:8890/v1/audio/speech")).toBe(
      "http://mini:8890/v1/audio/speech",
    );
  });

  it("assumes plain http for a host:port typed without a scheme", () => {
    expect(speechEndpointUrl("192.168.1.10:8890")).toBe("http://192.168.1.10:8890/v1/audio/speech");
    expect(speechEndpointUrl(" mini:8890/v1 ")).toBe("http://mini:8890/v1/audio/speech");
    expect(speechEndpointUrl("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/audio/speech",
    );
  });
});

const collect = (stream: Stream.Stream<Uint8Array, SpeechBackendError>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat([...chunks])));

const fakeClient = (
  onRequest: (request: Parameters<typeof HttpClientResponse.fromWeb>[0]) => Response,
) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, onRequest(request))),
  );

describe("SpeechSynthesis", () => {
  it.effect("fails clearly when no backend is configured", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechSynthesis;
      const error = yield* speech.synthesize({ text: "hello" }).pipe(Effect.flip);
      expect(error._tag).toBe("SpeechBackendNotConfiguredError");
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(serverSettingsLayerTest()),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              fakeClient(() => {
                throw new Error("must not call the backend");
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("posts the OpenAI speech request and streams the audio back", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; body: string; auth: string | null }> = [];
      const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
      const speech = yield* SpeechSynthesis.pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              serverSettingsLayerTest({
                speech: {
                  textToSpeechUrl: "http://mini:8890",
                  textToSpeechApiKey: "secret",
                  textToSpeechVoice: "pm_alex",
                },
              }),
            ),
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.sync(() => {
                    const body = request.body;
                    const text =
                      body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
                    seen.push({
                      url: request.url,
                      body: text,
                      auth: request.headers["authorization"] ?? null,
                    });
                    return HttpClientResponse.fromWeb(
                      request,
                      new Response(audio, {
                        status: 200,
                        headers: { "content-type": "audio/wav" },
                      }),
                    );
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      const stream = yield* speech.synthesize({ text: "Olá" });
      const bytes = yield* collect(stream);
      expect([...bytes]).toEqual([...audio]);
      expect(seen).toEqual([
        {
          url: "http://mini:8890/v1/audio/speech",
          body: '{"model":"kokoro","input":"Olá","voice":"pm_alex","response_format":"wav"}',
          auth: "Bearer secret",
        },
      ]);
    }),
  );

  it.effect("turns a backend error status into a SpeechBackendError", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechSynthesis;
      const error = yield* speech.synthesize({ text: "hello" }).pipe(Effect.flip);
      expect(error._tag).toBe("SpeechBackendError");
      expect(error._tag === "SpeechBackendError" ? error.status : null).toBe(503);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            serverSettingsLayerTest({ speech: { textToSpeechUrl: "http://mini:8890" } }),
          ),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              fakeClient(() => new Response("down", { status: 503 })),
            ),
          ),
        ),
      ),
    ),
  );
});
