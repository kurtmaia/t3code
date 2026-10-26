/**
 * Per-model voices. Rules are lines of `model-prefix = voice`; a thread's model
 * slug is matched case-insensitively against each prefix in order, and the
 * first match names the voice. Blank lines and `#` comments are ignored, so
 * the setting reads like a small config file rather than a form.
 */

export interface SpeechVoiceRule {
  readonly modelPrefix: string;
  readonly voice: string;
}

export function parseSpeechVoiceRules(text: string): ReadonlyArray<SpeechVoiceRule> {
  const rules: SpeechVoiceRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const modelPrefix = line.slice(0, separator).trim().toLowerCase();
    const voice = line.slice(separator + 1).trim();
    if (modelPrefix.length === 0 || voice.length === 0) continue;
    rules.push({ modelPrefix, voice });
  }
  return rules;
}

/**
 * The voice a rule picks for `model`, or undefined to use the environment's
 * default voice. The longest matching prefix wins, so `claude-opus-5` and
 * `claude-opus-5-5` can both have rules in any order. A provider prefix such
 * as `github-copilot/` in front of the id is ignored.
 */
export function resolveSpeechVoice(
  rulesText: string,
  model: string | null | undefined,
): string | undefined {
  if (!model) return undefined;
  const full = model.trim().toLowerCase();
  const slug = full.slice(full.lastIndexOf("/") + 1);
  if (slug.length === 0) return undefined;
  let best: SpeechVoiceRule | undefined;
  for (const rule of parseSpeechVoiceRules(rulesText)) {
    if (!slug.startsWith(rule.modelPrefix) && !full.startsWith(rule.modelPrefix)) continue;
    if (best === undefined || rule.modelPrefix.length > best.modelPrefix.length) best = rule;
  }
  return best?.voice;
}
