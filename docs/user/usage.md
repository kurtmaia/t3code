# Review usage

The Usage page shows provider-reported quota remaining at the top, followed by raw activity from
your connected environments. It reads the providers' local session history and shows
API-equivalent token cost, processed tokens, cache savings, provider shares, and model breakdowns.
Subscription billing is separate from the raw token cost shown here. GitHub Copilot is available as
a provider when its CLI is installed and logged in.

Quota windows come directly from each provider. Each provider reports several at once — Claude
Code a session window and a weekly cap per model family, Codex a primary and a secondary — and the
page shows the one closest to running out, so a tight weekly cap is not hidden behind a fresh
session. The label under each number says which window it is. Copilot appears here only once you
have enabled it in Settings.
When a provider does not expose quota data, the page labels that window as unavailable instead of
estimating it from token usage.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
