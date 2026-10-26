# Spoken replies

T3 Code can read an agent's replies aloud, so you can follow a thread while your eyes are on
something else. Reading is off unless you ask for it, and it is always a per-device choice: only
the device where you turned it on speaks, so a phone and a desktop open on the same thread never
talk over each other.

## Turning it on

- **For one thread.** Open the thread's menu from its title in the chat header and choose **Read
  replies aloud**. The same entry turns it off again. The command palette offers **Read replies
  aloud in this thread**, and the `voice.toggleSpokenReplies` keybinding toggles the open thread.
- **By default.** **Settings** → **General** → **Voice** → **Read replies aloud by default** makes
  every thread speak unless that thread has its own choice. Threads you have switched on or off
  individually keep their choice.

While a thread is being read, T3 Code speaks for it when it is open:

- **Finished replies.** When a turn completes, the agent's final message is read with your voice.
  Code blocks, tables, and diagrams are skipped with a short note, links are read by their label,
  and file paths by their file name. Long replies are cut at a sentence boundary with "There's
  more in the thread."
- **Questions and approvals.** When the agent asks you a question or needs permission to run a
  command, read a file, or change a file, T3 Code says so once, as soon as the request appears.
- **Errors.** A turn that stops with an error is announced.

Nothing already on screen is read back: opening a thread, or turning reading on in the middle of a
turn, starts from that moment. Sending a new message, switching threads, or turning reading off
stops speech immediately.

## Reading something on demand

You do not need reading turned on to hear a specific part of a thread:

- **A whole reply.** Hover an agent message and press the speaker button next to **Copy**. It
  reads the full message, without the length cap used for automatic reading. Press it again to
  stop.
- **A passage.** Select text inside an agent message and choose **Read aloud** from the small
  toolbar that appears, next to **Ask about this**.

While T3 Code is speaking, a **Reading aloud** banner with a **Stop** button sits above the
composer. The command palette also offers **Stop speaking**, and `voice.stopSpeaking` can be bound
to a key in **Settings** → **Keybindings**.

## Voice and speed

Pick a voice and a speaking rate under **Settings** → **General** → **Voice**. The list shows the
voices installed on your device, with the ones in your language first. **Test** plays a short
sample so you can compare them. Voices come from your operating system, so installing a
higher-quality voice there makes it available here.

## Neural voice

System voices are convenient but sound mechanical. For a natural voice, point the environment at
an OpenAI-compatible text-to-speech server under **Settings** → **General** → **Voice** →
**Neural voice server**. Self-hosted servers such as Kokoro-FastAPI or Speaches work, and so does
OpenAI's speech API with an API key. Enter the server's address, for example
`http://localhost:8890`, pick a voice name the server knows, and press **Test**.

The server setting belongs to the environment, not the device: every device connected to that
environment hears the same voice, including a phone on a tunnel, and the address and key never
leave the server. Settings edits the environment this device is paired to; a remote environment
has its own settings file. Replies are rendered a sentence or two at a time, so speech starts about a
second after the turn finishes. If the server cannot be reached, the reply falls back to the
system voice and a notice explains why, once per session.

## A voice per agent

With a neural voice server set, different models can speak with different voices. Under **Voice by
model**, enter one rule per line as `model prefix = voice`, for example:

```
claude-fable = bm_daniel
claude-opus = am_michael
```

A rule matches when it is the start of a thread's model id, ignoring any provider name before a
`/`; the longest matching rule wins, so `claude-opus-5` and `claude-opus-5-5` can both have one.
Models without a match use the voice above the rules. Ask the server for its voice names with
`GET /v1/audio/voices`; a voice costs nothing extra to use, since every voice runs on the same
model.

## Where it works

Spoken replies use the speech voices built into your browser or the desktop app and need no
account or network access. They work in the desktop app and in the web app, including on a phone's
browser. On iPhone and iPad, Safari only allows speech to start from a tap, which is why turning the
feature on confirms itself out loud. After reloading the page, tap anywhere once before expecting
a reply to be spoken. Speech pauses when the screen locks or Safari goes to the background. Browsers without speech voices show the setting as unavailable.
