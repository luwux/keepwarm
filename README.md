# keepwarm

An idle-session guard for Claude Code's 1-hour prompt cache. macOS only for now.

On a Claude subscription the main conversation's prompt cache lives for an hour after the
last request. Come back later and the whole context is written again: a 300K-token Opus 5.5
session costs about $2.4 to rewrite, against about $0.06 to read it warm. keepwarm watches
each session and speaks up *before* the hour runs out.

## What it does

- **Status line countdown**: `缓存 42m` until this session's cache lapses, refreshed on
  every model request, tool-result requests included.
- **Idle reminder** (~50 minutes after the last turn, only for sessions above
  `remindMinContext`): a desktop notification that jumps back to the session, plus a band
  above the prompt. With `idleCheck: judge` a fork of the session first decides whether to
  compact, keep warm or leave it; the fork reads the cache (it costs the cache-read rate,
  about $0.03–0.10 at 100–400K tokens) and refreshes it.
- **Keep-warm windows**: `/keepwarm on 8h` pings the cache whenever 55 minutes have passed since
  the last request, for 8 hours, whatever the session is doing: working, waiting on background
  work, or waiting on you. Only `/keepwarm off` ends it: your messages do not (while you work, your
  own requests keep the cache warm and nothing is sent). A window opened from a reminder's button or
  by the model covers an absence, so it ends when you write in that session.
  At most `pingLimit` pings per session in any `pingLimitHours` (15 in 12 hours by default).
- **Alerts** (`/keepwarm alert on`, off by default): a Mac notification (and a phone push when you
  are away) only for what should not happen: a window whose pings could not go out, the cache
  rewritten within the hour on the same model, the ping limit reached, or keepwarm's own daily
  budget for requests you did not ask for (`dailyBudgetUsd`, $3) exceeded, after which the idle
  check falls back to the free notice until midnight. At most one per kind and session an hour.
- **Button panel** (`/keepwarm panel`): the cache countdown, the window, the pending advice and
  buttons to compact, keep warm 8 hours (as `/keepwarm on 8h`), stop keeping warm or close. The
  band above the prompt is not drawn on the phone, so when the Claude app on the phone opens the
  session (Remote Control), or a reminder arrives while it is open, the panel opens by itself, and
  it closes again when the phone leaves. The phone push is titled with the session's own title.
- **Leaving**: `/keepwarm leave 2h` asks every live, warm session for its own verdict and
  shows one summary.
- **Never blocks** a prompt unless you turn `guard refuse` on.

## Every request is accounted for

All requests (forks) and changes (notifications, compact, files it writes) go through one
audit layer that records the real `usage` returned by the API: cache read, cache write,
input and output tokens, and the dollar cost. `/keepwarm log` shows it;
`python3 tests/check-audit.py` fails the build if any effectful call bypasses that layer.

## Cost and risk

keepwarm spends your quota to save it. Each fork or ping is a real request billed at the
cache-read rate; a keep-warm window of 3 hours on a 300K session costs about $0.20, which
pays off only if you come back within it. Defaults are conservative: `idleCheck` is `notify`
(free), nothing is automatic, and pings stop at the cap or when the cache is found cold.
Anthropic can change cache behaviour at any time; check `/keepwarm log` against your usage.

## Install

```
claude plugin marketplace add <this repo>
claude plugin install keepwarm
```

Settings live in `/config` (or `pluginConfigs.keepwarm.options` in `~/.claude/settings.json`):
`idleCheck` (notify | judge | off), `remindMinContext`, `pingLimit`, `pingLimitHours`,
`dailyBudgetUsd`, `awayMinutes`,
`ntfyConfigFile` (a JSON file `{"server": "https://ntfy.sh", "topic": "…"}` for read-only phone
notifications; empty disables them). Desktop notifications use
[terminal-notifier](https://github.com/julienXX/terminal-notifier) when it is installed.

The interface text is Chinese for now.

## Credits

Keep-warm pings are derived from [cache-tax](https://github.com/karanb192/cache-tax)
(MIT, Karan Bansal); see `LICENSE.cache-tax`.
