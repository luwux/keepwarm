# keepwarm

[English](#english) · [中文](#中文)

An idle-session guard for Claude Code's 1-hour prompt cache, written as a Claude Code mod
(a hooks-module plugin). macOS only. The interface text is Chinese for now.

一个 Claude Code mod（hooks 插件），守护主对话 1 小时的提示缓存。仅支持 macOS，界面文字目前是中文。

## Install / 安装

In a terminal session of Claude Code (tested on 2.1.296):
在 Claude Code 的终端会话里输入（在 2.1.296 上测试过）：

```
/plugin install keepwarm --marketplace luwux/keepwarm
```

Answer `y` to add the marketplace, then pick the user scope. Installed at the user scope it also
loads in the desktop app's Code tab.
回答 `y` 添加 marketplace，再选 user 范围。装在 user 范围后，桌面 app 的 Code 标签页里也会加载。

---

## English

### Why

On a Claude subscription the main conversation's prompt cache lives for an hour after the last
request. Come back later and the whole context is written again: a 300K-token Opus 5.5 session
costs about $2.4 to rewrite, against about $0.06 to read it warm. keepwarm watches each session
and speaks up *before* the hour runs out.

### What it does

- **Status line countdown**: `缓存 42m` until this session's cache lapses, refreshed on every
  model request, tool-result requests included.
- **Idle reminder** (~50 minutes after the last turn, only for sessions above
  `remindMinContext`): a desktop notification that jumps back to the session, plus a band above
  the prompt. With `idleCheck: judge` a fork of the session first decides whether to compact,
  keep warm or leave it; the fork reads the cache (about $0.03–0.10 at 100–400K tokens) and
  refreshes it.
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

### Every request is accounted for

All requests (forks, pings) and changes (notifications, compact, files it writes) go through one
audit layer that records the real `usage` returned by the API and its dollar cost.
`/keepwarm log` shows it; `python3 tests/check-audit.py` fails if any effectful call bypasses it.

### Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` or `status` | current state |
| `on 8h` / `off` / `auto` | keep warm for 8 hours / stop and forbid the model to start one / allow it again |
| `check` | judge now: compact, keep warm or leave it |
| `leave 2h on\|off` | tell all sessions you are away (Mac on / lid closed) |
| `idle off\|notify\|judge` | what the 50-minute idle check does |
| `alert on\|off\|test` | alerts |
| `policy ask\|auto\|warm\|off` | per-project idle policy |
| `guard refuse\|warn\|off` | when you write to a session whose cache is already cold |
| `log`, `ledger` | audit log, cold-write ledger |
| `push`, `panel` | test push with buttons, button pane on the Mac |

### Settings

In `/config`, or `pluginConfigs.keepwarm.options` in `~/.claude/settings.json`: `idleCheck`
(notify | judge | off), `remindMinContext`, `pingLimit`, `pingLimitHours`, `dailyBudgetUsd`,
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

### Cost and risk

keepwarm spends your quota to save it. Each fork or ping is a real request billed at the
cache-read rate; a 3-hour window on a 300K session costs about $0.20, which pays off only if you
come back within it. Defaults are conservative: `idleCheck` is `notify` (free), nothing is
automatic, and pings stop at the cap or when the cache is found cold. Anthropic can change cache
behaviour at any time; check `/keepwarm log` against your usage. Prices are list prices of
September 2026, hard-coded in `hooks/register.tsx`.

---

## 中文

### 为什么

用 Claude 订阅时，主对话的提示缓存在最后一次请求后保留 1 小时。过了这一小时再回来，整段上下文要重新写一遍：
300K tokens 的 Opus 5.5 会话重写一次约 $2.4，而缓存还热时读一次只要约 $0.06。keepwarm 盯着每个会话，在这一小时用完**之前**提醒你。

### 功能

- **状态栏倒计时**：`缓存 42m`，显示这个会话的缓存还剩多久。每次模型请求（包括工具结果）都会刷新。
- **空闲提醒**：最后一轮结束约 50 分钟后，只针对上下文超过 `remindMinContext` 的会话，发一条能跳回会话的桌面通知，并在输入框上方显示提示条。
  设成 `idleCheck: judge` 时，会先让会话的一个分叉判断该 compact、保温还是不管。分叉读的是缓存（100–400K tokens 约 $0.03–0.10），顺便也刷新了缓存。
- **保温窗口**：`/keepwarm on 8h` 在 8 小时内，每当距上次请求满 55 分钟就 ping 一次缓存，不管会话在做什么，只有 `/keepwarm off` 能关。
  从提醒按钮或由模型开的窗口是为了你不在的时候，你回到这个会话发消息就结束。每个会话在 `pingLimitHours` 内最多 ping `pingLimit` 次。
- **手机按钮**（可选，用 [ntfy](https://ntfy.sh)）：你离开 Mac 时，提醒会推到手机上，带 compact、保温 N 小时、不管三个按钮。
  - 点按钮会把一次性 token 发到 `reply_topic`。会话有按钮在外时每 20 秒读一次，照做后再推一条确认。
  - 同一条通知的三个按钮是一组，点了任意一个整组作废，再点什么都不会发生。
  - token 3 小时后过期。缓存已经冷了才点的，会回一条说明，不执行。
- **报警**（`/keepwarm alert on`，默认关）：只报不该发生的事：保温窗口的 ping 没发出去、同一模型一小时内缓存被重写、ping 次数到上限、keepwarm 自己的每日预算（`dailyBudgetUsd`，$3）超了。
- **离开**：`/keepwarm leave 2h` 让每个还热着的会话各自给出建议，汇总成一份。
- **从不拦截**你的消息，除非你打开 `guard refuse`。

### 每笔请求都有账

所有请求（分叉、ping）和改动（通知、compact、写文件）都经过同一个审计层，记录 API 返回的真实 `usage` 和花费。
`/keepwarm log` 可以查看；有任何产生副作用的调用绕过审计层，`python3 tests/check-audit.py` 就会失败。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/keepwarm` 或 `status` | 看状态 |
| `on 8h` / `off` / `auto` | 保温 8 小时 / 关掉并禁止模型自己开 / 重新允许 |
| `check` | 现在判断一次：compact、保温还是不管 |
| `leave 2h on\|off` | 告诉所有会话你要离开（电脑开着 / 合盖） |
| `idle off\|notify\|judge` | 空闲 50 分钟时什么都不做 / 免费提醒 / 判断一次 |
| `alert on\|off\|test` | 报警开关 |
| `policy ask\|auto\|warm\|off` | 本项目空闲时的策略 |
| `guard refuse\|warn\|off` | 缓存已冷还发消息时怎么办 |
| `log`、`ledger` | 审计记录、冷写入账本 |
| `push`、`panel` | 发带按钮的测试推送、在 Mac 上打开按钮面板 |

### 设置

在 `/config` 里，或 `~/.claude/settings.json` 的 `pluginConfigs.keepwarm.options`：`idleCheck`（notify | judge | off）、`remindMinContext`、`pingLimit`、`pingLimitHours`、`dailyBudgetUsd`、`awayMinutes`、`ntfyConfigFile`。

`ntfyConfigFile` 指向一个 JSON 文件，格式见上方英文部分。
- 没有 `reply_topic` 时推送不带按钮；路径留空则不推手机。
- 公共 ntfy.sh 上任何知道 topic 名字的人都能读到内容，推送里有会话标题和摘要，所以请用很长的随机名字。
- 别人伪造的点击不起作用，因为 token 是随机的。
- 装了 [terminal-notifier](https://github.com/julienXX/terminal-notifier) 时用它发桌面通知。

### 花费与风险

keepwarm 是花额度来省额度：每次分叉或 ping 都是真实请求，按缓存读取价计费。300K 的会话保温 3 小时约 $0.20，只有你在这段时间内回来才划算。

默认设置很保守：
- `idleCheck` 是 `notify`（免费）。
- 不会自动做任何事。
- ping 到上限或发现缓存已冷就停。

Anthropic 随时可能改变缓存行为，请用 `/keepwarm log` 对照你的用量。价格是 2026 年 9 月的公开价，写死在 `hooks/register.tsx` 里。

---

## Development / 开发

```
claude --plugin-dir .            # run from this folder / 从这个目录加载
claude plugin validate .
claude plugin test .
python3 tests/check-audit.py
```

## Credits / 致谢

Keep-warm pings are derived from [cache-tax](https://github.com/karanb192/cache-tax)
(MIT, Karan Bansal); see `LICENSE.cache-tax`. keepwarm itself is MIT; see `LICENSE`.
保温 ping 源自 [cache-tax](https://github.com/karanb192/cache-tax)（MIT，Karan Bansal），见 `LICENSE.cache-tax`。keepwarm 本身采用 MIT 许可，见 `LICENSE`。
