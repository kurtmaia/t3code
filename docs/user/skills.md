# Use a skill with any provider

Skills started as a Claude feature, but in T3 Code you can call one from any provider. Type `$`
in the composer, pick a skill, and send. Codex, Cursor, Grok, OpenCode and GitHub Copilot all
follow it for that turn.

## Where skills come from

T3 Code reads the same three folders for every provider:

1. `~/.claude/skills` (or the `skills` folder inside `CLAUDE_CONFIG_DIR`, if you set one)
2. `<workspace>/.agents/skills`
3. `<workspace>/.claude/skills`

Each skill is a folder with a `SKILL.md` inside. If the same skill name appears in more than one
folder, the later folder wins. You do not have to copy a skill anywhere to use it elsewhere —
one copy is reachable from every provider.

## The Shared badge

In the `$` menu, a skill marked **Shared** is one the current provider does not have itself.
T3 Code sends that skill's instructions along with your message so the provider can follow it.

Skills without the badge are the provider's own, and it loads them the way it always has. Where
a provider already has a skill of the same name, its own version wins and nothing is sent.

## What gets sent

Only the skills you actually reference. A `$` that matches no skill — `$HOME` in a shell command,
say — is left alone and sent as ordinary text.

A referenced skill's instructions travel with that one turn. Skills are not installed into the
provider and nothing is written to its configuration.
