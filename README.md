# keepwarm

English · [中文](README.zh-CN.md)

An idle-session guard for Claude Code's 1-hour prompt cache, written as a Claude Code mod
(a hooks-module plugin). macOS only. The interface text is Chinese for now.

## Install

In a terminal session of Claude Code (tested on 2.1.296):

```
/plugin install keepwarm --marketplace luwux/keepwarm
```

Answer `y` to add the marketplace, then pick the user scope. Installed at the user scope it also
loads in the desktop app's Code tab.

## Why

On a Claude subscription the main conversation's prompt cache lives for an hour after the last
request. Come back later and the whole context is written again: a 300K-token Opus 5.5 session
costs about $2.4 to rewrite, against about $0.06 to read it warm. keepwarm watches each session
and speaks up *before* the hour runs out.

## What it does

- **Status line countdown**: `缓存 42m` ("cache 42m") until this session's cache lapses, refreshed on every
  model request, tool-result requests included.
- **Idle reminder** (~50 minutes after the last turn, only for sessions above
  `remindMinContext`): a desktop notification that jumps back to the session, plus a band above
  the prompt. With `idleCheck: judge` a fork of the session first decides whether to compact,
  keep warm or leave it; the fork reads the cache (about $0.03–0.10 at 100–400K tokens) and
  refreshes it. With `/keepwarm autorun 2`, a reminder nobody answers within 2 minutes (no tap,
  no prompt in that session) is carried out: compact or keep warm as advised. A session that
  scheduled its own wakeup (ScheduleWakeup, `/loop`) before the cache lapses gets no idle check
  and no pings: its own request refreshes the cache.
- **Keep-warm windows**: `/keepwarm on 8h` pings the cache whenever 55 minutes have passed since
  the last request, for 8 hours, whatever the session is doing. Only `/keepwarm off` ends it.
  A window opened from a reminder's button or by the model covers an absence, so it ends when
  you write in that session. At most `pingLimit` pings per session in any `pingLimitHours`.
- **Buttons on the phone** (optional, via [ntfy](https://ntfy.sh)): when you are away from the
  Mac, the reminder is pushed to your phone with buttons: compact, keep warm N hours, leave it.
  A tap posts a one-time token to `reply_topic`; the session polls that topic every 20 seconds
  while it has buttons out, does what was tapped and pushes a confirmation. The three buttons of
  one notification share one token group: the first tap voids them all, so a second tap does
  nothing. Tokens expire after 3 hours; a tap after the cache has lapsed is answered, not acted on.
- **Alerts** (`/keepwarm alert on`, off by default): only for what should not happen: a window
  whose pings could not go out, the cache rewritten within the hour on the same model, the ping
  limit reached, or keepwarm's own daily budget (`dailyBudgetUsd`, $3) exceeded.
- **Leaving**: `/keepwarm leave 2h` asks every live, warm session for its own verdict and shows
  one summary.
- **Never blocks** a prompt unless you turn `guard refuse` on.

## Every request is accounted for

All requests (forks, pings) and changes (notifications, compact, files it writes) go through one
audit layer that records the real `usage` returned by the API and its dollar cost.
`/keepwarm log` shows it; `python3 tests/check-audit.py` fails if any effectful call bypasses it.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` or `status` | current state |
| `on 8h` / `off` / `auto` | keep warm for 8 hours / stop and forbid the model to start one / allow it again |
| `check` | judge now: compact, keep warm or leave it |
| `leave 2h on\|off` | tell all sessions you are away (Mac on / lid closed) |
| `idle off\|notify\|judge` | what the 50-minute idle check does |
| `autorun 2\|off` | carry out an unanswered reminder after 2 minutes / only wait for you |
| `alert on\|off\|test` | alerts |
| `policy ask\|auto\|warm\|off` | per-project idle policy |
| `guard refuse\|warn\|off` | when you write to a session whose cache is already cold |
| `log`, `ledger` | audit log, cold-write ledger |
| `push`, `panel` | test push with buttons, button pane on the Mac |

## Settings

In `/config`, or `pluginConfigs.keepwarm.options` in `~/.claude/settings.json`: `idleCheck`
(notify | judge | off), `autorunMinutes`, `remindMinContext`, `pingLimit`, `pingLimitHours`, `dailyBudgetUsd`,
`awayMinutes`, `ntfyConfigFile`.

`ntfyConfigFile` points to a JSON file:

```json
{ "server": "https://ntfy.sh", "topic": "<push topic>", "reply_topic": "<button topic>" }
```

Without `reply_topic` the pushes carry no buttons; an empty path disables phone pushes. On the
public ntfy.sh server anyone who knows a topic name can read it, so use long random names: the
push carries session titles and summaries. A forged tap cannot act, since tokens are random.
Desktop notifications use [terminal-notifier](https://github.com/julienXX/terminal-notifier)
when it is installed.

## Cost and risk

keepwarm spends your quota to save it. Each fork or ping is a real request billed at the
cache-read rate; a 3-hour window on a 300K session costs about $0.20, which pays off only if you
come back within it. Defaults are conservative: `idleCheck` is `notify` (free), nothing is
automatic, and pings stop at the cap or when the cache is found cold. Anthropic can change cache
behaviour at any time; check `/keepwarm log` against your usage. Prices are list prices of
September 2026, hard-coded in `hooks/register.tsx`.

## Development

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
python3 tests/check-audit.py
```

## Credits

Keep-warm pings are derived from [cache-tax](https://github.com/karanb192/cache-tax)
(MIT, Karan Bansal); see `LICENSE.cache-tax`. keepwarm itself is MIT; see `LICENSE`.
