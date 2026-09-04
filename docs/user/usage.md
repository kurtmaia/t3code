# Review usage

The Usage page shows provider-reported quota remaining at the top, followed by raw activity from
your connected environments. It reads the providers' local session history and shows
API-equivalent token cost, processed tokens, cache savings, provider shares, and model breakdowns.
Subscription billing is separate from the raw token cost shown here. GitHub Copilot is available as
a provider when its CLI is installed and logged in.

Quota windows come directly from each provider: Claude Code and Codex show their current-session
windows, while GitHub Copilot reports its account allowance. Copilot appears here only once you
have enabled it in Settings.
When a provider does not expose quota data, the page labels that window as unavailable instead of
estimating it from token usage.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
