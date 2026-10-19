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

- **Idle check, handled without asking** (~50 minutes after the last turn, only for sessions
  above `remindMinContext`, 200K by default; smaller ones get no judge, no ping and no
  compaction). If background work the session started (a shell, a subagent, a monitor) is still
  running, nothing is judged: that work wakes the session when it reports, so the cache is kept
  warm until then, at most 12 hours after the last turn (then the session is compacted); in
  fifteen days of the author's sessions 80% of such waits reported within 6 hours and 92% within
  12. A watch on a published artifact and an idle teammate do not count (they wake nobody), nor,
  after the app restarts, the work of the process before (it died with it). Otherwise, with `idleCheck: judge` a fork of
  the session decides whether to compact, keep warm or leave it; the fork reads the cache (about
  $0.03–0.10 at 100–400K tokens) and refreshes it. If the judge finds the cache already gone (the
  server sometimes drops it within the hour), nothing more is done: keeping warm or compacting would
  pay the rewrite a second time. Otherwise, with no notification:
  - compact: the session is compacted about 55 minutes later, when the hour the judge's own
    read bought is nearly over; it costs the same, and coming back before then keeps the full
    context;
  - keep warm: the cache is kept warm until 6 hours after the last turn, then the session is
    compacted; any turn in the session ends this (yours, or background work reporting), and the
    next quiet stretch is checked afresh. Night is no exception: an idle Mac is no sign you
    have gone to bed, and coming back within hours, the pings cost less than compacting and
    rewriting the cache;
  - leave it: nothing.

  Six hours comes from two weeks of the author's sessions: daytime returns came within six hours
  or the next day, and up to six hours the pings cost about what the compactions they spare
  save. A session that scheduled its own wakeup before the cache lapses (ScheduleWakeup, `/loop`,
  a cron of its own, or a background shell that starts with `sleep N`) gets no idle check and no
  pings, unless the wakeup does not come; so the model
  need not wake itself to keep the cache warm. Nor does a session with no project, which runs in a
  folder the app made for it (the + beside *This computer*; `skipScratch`), or one filed under a
  desktop sidebar group named in `skipGroups` (default `Chat`). With `idleCheck: notify` you get a free desktop reminder
  instead. Claude Code's own idle compaction does the same without judging; turn it off with
  `"idleCompaction": false` if you use this.
- **Nothing under the prompt**: no status line, warm or cold; `/keepwarm` shows the state.
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
- **Cold-write notice**: whenever the whole context is written again, a notice in Claude says how
  many tokens, what it cost and why: the cache had lapsed, it lapsed while a keep-warm window
  was open, the model changed, or the prompt prefix changed unexpectedly; and whether a background
  task's report set it off. Not for a new session's first message or right after a compaction;
  nothing goes to the Mac's notifications or the phone (the opt-in alerts below aside).
- **Alerts** (`/keepwarm alert on`, off by default): only for what should not happen: a window
  whose pings could not go out, the cache rewritten within the hour on the same model, the ping
  limit reached, or keepwarm's own daily budget (`dailyBudgetUsd`, $10) exceeded.
- **Leaving**: `/keepwarm leave 2h` asks every live, warm session for its own verdict and shows
  one summary.
- **Not while the Mac sleeps**: with the lid closed the Mac wakes for seconds now and then; no
  judge or ping goes out then, since the sleep that follows cuts it and it is sent again after the
  cache has lapsed.
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
| `alert on\|off\|test` | alerts |
| `policy auto\|warm\|off` | per-project idle policy: handle as judged / always keep warm / nothing |
| `guard refuse\|warn\|off` | when you write to a session whose cache is already cold |
| `log`, `ledger` | audit log, cold-write ledger |
| `push`, `panel` | test push with buttons, button pane on the Mac |

## Settings

In `/config`, or `pluginConfigs.keepwarm.options` in `~/.claude/settings.json`: `idleCheck`
(notify | judge | off), `remindMinContext`, `skipScratch`, `skipGroups`, `pingLimit`, `pingLimitHours`, `dailyBudgetUsd`,
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
