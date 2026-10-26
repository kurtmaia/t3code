import { describe, expect, it } from "vite-plus/test";

import { parseSpeechVoiceRules, resolveSpeechVoice } from "./voiceRules.ts";

const RULES = [
  "# agents",
  "claude-fable = bm_fable",
  "claude-opus=am_michael",
  "",
  "gpt = af_nova",
  "broken line without separator",
  "= missing_prefix",
].join("\n");

describe("parseSpeechVoiceRules", () => {
  it("reads prefix = voice lines and skips comments, blanks, and malformed lines", () => {
    expect(parseSpeechVoiceRules(RULES)).toEqual([
      { modelPrefix: "claude-fable", voice: "bm_fable" },
      { modelPrefix: "claude-opus", voice: "am_michael" },
      { modelPrefix: "gpt", voice: "af_nova" },
    ]);
  });
});

describe("resolveSpeechVoice", () => {
  it("picks the first rule whose prefix matches the model, case-insensitively", () => {
    expect(resolveSpeechVoice(RULES, "claude-fable-5-1")).toBe("bm_fable");
    expect(resolveSpeechVoice(RULES, "Claude-Opus-5")).toBe("am_michael");
    expect(resolveSpeechVoice(RULES, "gpt-5.3-codex")).toBe("af_nova");
  });

  it("lets the longest prefix win so sibling models can each have a rule, in any order", () => {
    const rules = "claude-opus-5 = am_michael\nclaude-opus-5-5 = bm_george\nclaude = af_heart";
    expect(resolveSpeechVoice(rules, "claude-opus-5-5")).toBe("bm_george");
    expect(resolveSpeechVoice(rules, "claude-opus-5")).toBe("am_michael");
    expect(resolveSpeechVoice(rules, "claude-sonnet-5")).toBe("af_heart");
  });

  it("ignores a provider prefix in front of the model id", () => {
    expect(resolveSpeechVoice(RULES, "github-copilot/claude-opus-5")).toBe("am_michael");
  });

  it("falls back to the default voice when nothing matches or there is no model", () => {
    expect(resolveSpeechVoice(RULES, "claude-sonnet-5")).toBeUndefined();
    expect(resolveSpeechVoice(RULES, null)).toBeUndefined();
    expect(resolveSpeechVoice("", "claude-fable-5")).toBeUndefined();
  });
});
