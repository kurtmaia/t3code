import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentSpeech } from "./speechSynthesisHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

describe("fetchEnvironmentSpeech", () => {
  it.effect("posts the text and returns the audio bytes", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const audio = new Uint8Array([82, 73, 70, 70, 9, 8, 7]);
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(
          new Response(audio, { status: 200, headers: { "content-type": "audio/wav" } }),
        );
      }) satisfies typeof fetch;

      const bytes = yield* fetchEnvironmentSpeech({
        prepared: PREPARED,
        input: { text: "Hello there" },
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect([...bytes]).toEqual([...audio]);
      expect(calls).toHaveLength(1);
      const [request, init] = calls[0]!;
      expect(String(request)).toBe("https://environment.example.test/api/speech/synthesize");
      expect(init.method).toBe("POST");
      const body =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : "";
      // The assertion inspects the serialized wire body, not a decoded domain value.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(body)).toEqual({ text: "Hello there" });
    }),
  );

  it.effect("surfaces a backend failure as a remote request error", () =>
    Effect.gen(function* () {
      const fetchFn = (() =>
        Promise.resolve(
          Response.json(
            { _tag: "SpeechBackendError", detail: "The speech backend answered HTTP 503." },
            { status: 502 },
          ),
        )) satisfies typeof fetch;
      const error = yield* fetchEnvironmentSpeech({
        prepared: PREPARED,
        input: { text: "Hello there" },
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)), Effect.flip);
      // Declared endpoint errors other than the shared auth family arrive wrapped,
      // with the backend error preserved as the cause for the UI to explain.
      expect(error._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(String(error.message)).toContain("SpeechBackendError");
    }),
  );
});
