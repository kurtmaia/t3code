# Speech

> For maintainers. Using T3 Code? See [docs/user/voice.md](../user/voice.md).

Spoken replies have two halves: a pure policy that decides what to say, and a renderer that makes
sound. Voice input (transcription) is planned on the same shape and is not built yet.

## What gets said

`packages/client-runtime/src/speech/` is platform-neutral and fully unit tested:

- `spokenReplyPolicy.ts` is a step function over a per-thread cursor. It emits a `reply` once the
  latest turn reaches `completed` and its assistant message stops streaming, an `approval` or
  `question` announcement the first time a pending request appears, an `error` announcement for a
  failed turn, and an `interrupt` flag when a new turn starts or the shown thread changes. Opening
  a thread baselines the cursor so history is never read back.
- `speakableText.ts` turns markdown into something a synthesizer can read: code fences, tables,
  and mermaid blocks become short placeholders, links keep their label, inline paths keep their
  basename, and the result is capped at a sentence boundary.

The web hook `apps/web/src/hooks/useSpokenReplies.ts` feeds the policy from the open thread's
projection and the composer's pending approvals and questions, and only speaks while the
client-local `spokenRepliesEnabled` setting is on. Keeping the cursor current while the feature is
off is deliberate: turning it on mid-turn must not replay what is on screen.

## How it is rendered

`apps/web/src/speech/speak.ts` is the single entry point. It replaces whatever is speaking and
picks one of two renderers:

- **System voice** (`speechSynthesis.ts`): the browser's `speechSynthesis`, with text split into
  short utterances because Chromium stops utterances that run past roughly fifteen seconds.
- **Speech backend** (`voicePlayer.ts`): audio fetched from the thread's environment and played
  through one `HTMLAudioElement`. Text is cut into sentence-sized clips; the next clip is requested
  while the current one plays. If the backend fails before anything played, the same text goes to
  the system voice and the hook shows one warning per session.

Both renderers share `speakingState.ts`: one "is speaking" flag for the UI and a generation
counter so a stale completion from a cancelled utterance cannot flip the flag for its successor.
`unlockVoicePlayer()` plays a silent clip from the gesture that turns the feature on, which is what
lets iOS Safari play later clips without a tap.

## The backend path

The server owns the backend address and key so clients, including phones on a tunnel, never
hold them:

- Settings: `ServerSettings.speech` (`textToSpeechUrl`, `textToSpeechModel`, `textToSpeechVoice`,
  `textToSpeechApiKey`) in `packages/contracts/src/settings.ts`. An empty URL means "system
  voices". The key is stored in plain text like other provider credentials in `settings.json`.
- Contract: `POST /api/speech/synthesize` in the `speech` group of `EnvironmentHttpApi`
  (`packages/contracts/src/environmentHttp.ts`), payload `SpeechSynthesizeInput`, success a
  streamed `audio/wav` body, errors `SpeechBackendNotConfiguredError` and `SpeechBackendError`.
  It requires `orchestration:read`.
- Server: `apps/server/src/speech/SpeechSynthesis.ts` posts an OpenAI-shaped request
  (`model`, `input`, `voice`, `response_format: "wav"`) to `<url>/v1/audio/speech`, accepting a
  bare origin, a `/v1` base, the full path, or a host:port with no scheme (http is assumed, https
  once an API key is set), and streams the response through unchanged.
  Kokoro-FastAPI, Speaches, and OpenAI all answer this shape.
- Playback: streaming servers write placeholder RIFF/data sizes; `voicePlayer.ts` finalizes them
  from the collected clip before handing the bytes to the audio element. The desktop renderer's
  content policy allows `media-src 'self' blob: data:` for that element and the silent unlock clip.
- Client: `packages/client-runtime/src/state/speechSynthesisHttp.ts` collects the stream over the
  prepared environment HTTP connection, and `state/speech.ts` exposes it as an environment
  command, mirroring the pull-request diff loader.

WAV was chosen over MP3 for the first version: no decoder, no encoder latency on the backend, and
about 48 KB per second of speech, which is fine on a LAN or a tunnel. Compressed formats are a
follow-up if phone bandwidth turns out to matter.
