# keepwarm

[English](README.md) · 中文

一个 Claude Code mod（hooks 插件），守护主对话 1 小时的提示缓存。仅支持 macOS，界面文字目前是中文。

## 安装

在 Claude Code 的终端会话里输入（在 2.1.296 上测试过）：

```
/plugin install keepwarm --marketplace luwux/keepwarm
```

回答 `y` 添加 marketplace，再选 user 范围。装在 user 范围后，桌面 app 的 Code 标签页里也会加载。

## 为什么

用 Claude 订阅时，主对话的提示缓存在最后一次请求后保留 1 小时。过了这一小时再回来，整段上下文要重新写一遍：
300K tokens 的 Opus 5.5 会话重写一次约 $2.4，而缓存还热时读一次只要约 $0.06。keepwarm 盯着每个会话，在这一小时用完**之前**提醒你。

## 功能

- **空闲检查，自动处理、不打扰你**：最后一轮结束约 50 分钟后，只针对上下文超过 `remindMinContext`（默认 200K）的会话；更小的会话不判断、不 ping、也不 compact。
  会话自己起的后台任务（后台命令、子代理、Monitor）还在跑时不做判断：任务回报时会唤醒会话，所以一直保温到那时，最长到最后一轮结束后 12 小时，到时 compact。作者 15 天的会话里，这种等待 80% 在 6 小时内回报，92% 在 12 小时内。已发布 artifact 的评论订阅、闲着的 teammate 不算（它们不会唤醒会话）；app 重启后，上一个进程的后台任务也不算（已经跟着进程停了）。
  没有后台任务时，设成 `idleCheck: judge` 会让会话的一个分叉判断该 compact、保温还是不管。分叉读的是缓存（100–400K tokens 约 $0.03–0.10），顺便也刷新了缓存。如果判断时发现缓存已经没了（服务端偶尔会在一小时内提前清掉），就什么也不做：这时保温或 compact 都要再重写一次。否则不发任何通知：
  - compact：约 55 分钟后再 compact，也就是判断本身续上的那一小时快用完时。花的钱一样，期间回来还能接着用完整的上下文；
  - 保温：保温到最后一轮结束后 6 小时，然后 compact；会话里有任何一轮（你发消息，或后台任务回报）就结束，之后的空闲重新检查。夜里也一样：Mac 闲着不代表你睡了，几小时内回来时保温比压掉再冷写入便宜；
  - 不管：什么都不做。

  6 小时来自作者两周的会话记录：白天要么 6 小时内回来，要么第二天才回来；6 小时以内，多 ping 的钱和少做 compact 省下的钱差不多抵消。
  会话自己定了缓存过期前的唤醒（ScheduleWakeup、`/loop`、会话自己的定时任务，或以 `sleep N` 开头的后台命令）时，不做空闲检查，也不 ping，除非到点没醒；所以模型不需要为了续缓存自己定时醒来。没有项目、跑在 app 自建临时文件夹里的会话（侧边栏 *This computer* 旁的 + 新建的聊天，`skipScratch`），以及放在侧边栏分组 `skipGroups`（默认 `Chat`）里的会话也一样。设成 `idleCheck: notify` 则只发一条免费的桌面提醒。
  Claude Code 自带的 idle compaction 做的是同一件事但不做判断，用这个插件时可以设 `"idleCompaction": false` 关掉它。
- **输入框下面不显示任何东西**：缓存热也好冷也好都没有状态栏小字，状态用 `/keepwarm` 查。
- **保温窗口**：`/keepwarm on 8h` 在 8 小时内，每当距上次请求满 55 分钟就 ping 一次缓存，不管会话在做什么，只有 `/keepwarm off` 能关。
  从提醒按钮或由模型开的窗口是为了你不在的时候，你回到这个会话发消息就结束。每个会话在 `pingLimitHours` 内最多 ping `pingLimit` 次。
- **手机按钮**（可选，用 [ntfy](https://ntfy.sh)）：你离开 Mac 时，提醒会推到手机上，带 compact、保温 N 小时、不管三个按钮。
  - 点按钮会把一次性 token 发到 `reply_topic`。会话有按钮在外时每 20 秒读一次，照做后再推一条确认。
  - 同一条通知的三个按钮是一组，点了任意一个整组作废，再点什么都不会发生。
  - token 3 小时后过期。缓存已经冷了才点的，会回一条说明，不执行。
- **冷写入提示**：每次整段重写上下文，在 Claude 里弹一条小提示，写明多少 tokens、多少钱、原因（缓存过期、保温期间缓存过期、换了模型、提示前缀意外变了），以及是不是后台任务回报触发的。新会话的第一条消息和 compact 之后那一次不算；不发 Mac 系统通知，也不推手机（下面可选的报警除外）。
- **报警**（`/keepwarm alert on`，默认关）：只报不该发生的事：保温窗口的 ping 没发出去、同一模型一小时内缓存被重写、ping 次数到上限、keepwarm 自己的每日预算（`dailyBudgetUsd`，$10）超了。
- **离开**：`/keepwarm leave 2h` 让每个还热着的会话各自给出建议，汇总成一份。
- **Mac 睡着时不发请求**：合盖后 Mac 会偶尔醒几秒做维护，这时不发判断也不发 ping，因为紧接着的睡眠会打断它，等开盖后重发时缓存已经过期了。
- **从不拦截**你的消息，除非你打开 `guard refuse`。

## 每笔请求都有账

所有请求（分叉、ping）和改动（通知、compact、写文件）都经过同一个审计层，记录 API 返回的真实 `usage` 和花费。
`/keepwarm log` 可以查看；有任何产生副作用的调用绕过审计层，`python3 tests/check-audit.py` 就会失败。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/keepwarm` 或 `status` | 看状态 |
| `on 8h` / `off` / `auto` | 保温 8 小时 / 关掉并禁止模型自己开 / 重新允许 |
| `check` | 现在判断一次：compact、保温还是不管 |
| `leave 2h on\|off` | 告诉所有会话你要离开（电脑开着 / 合盖） |
| `idle off\|notify\|judge` | 空闲 50 分钟时什么都不做 / 免费提醒 / 判断一次 |
| `alert on\|off\|test` | 报警开关 |
| `policy auto\|warm\|off` | 本项目空闲时：按判断自动处理 / 总是保温 / 不管 |
| `guard refuse\|warn\|off` | 缓存已冷还发消息时怎么办 |
| `log`、`ledger` | 审计记录、冷写入账本 |
| `push`、`panel` | 发带按钮的测试推送、在 Mac 上打开按钮面板 |

## 设置

在 `/config` 里，或 `~/.claude/settings.json` 的 `pluginConfigs.keepwarm.options`：`idleCheck`（notify | judge | off）、`remindMinContext`、`skipScratch`、`skipGroups`、`pingLimit`、`pingLimitHours`、`dailyBudgetUsd`、`awayMinutes`、`ntfyConfigFile`。

`ntfyConfigFile` 指向一个 JSON 文件：

```json
{ "server": "https://ntfy.sh", "topic": "<推送 topic>", "reply_topic": "<按钮 topic>" }
```

- 没有 `reply_topic` 时推送不带按钮；路径留空则不推手机。
- 公共 ntfy.sh 上任何知道 topic 名字的人都能读到内容，推送里有会话标题和摘要，所以请用很长的随机名字。
- 别人伪造的点击不起作用，因为 token 是随机的。
- 装了 [terminal-notifier](https://github.com/julienXX/terminal-notifier) 时用它发桌面通知。

## 花费与风险

keepwarm 是花额度来省额度：每次分叉或 ping 都是真实请求，按缓存读取价计费。300K 的会话保温 3 小时约 $0.20，只有你在这段时间内回来才划算。

默认设置很保守：
- `idleCheck` 是 `notify`（免费）。
- 不会自动做任何事。
- ping 到上限或发现缓存已冷就停。

Anthropic 随时可能改变缓存行为，请用 `/keepwarm log` 对照你的用量。价格是 2026 年 9 月的公开价，写死在 `hooks/register.tsx` 里。

## 开发

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
python3 tests/check-audit.py
```

## 致谢

保温 ping 源自 [cache-tax](https://github.com/karanb192/cache-tax)（MIT，Karan Bansal），见 `LICENSE.cache-tax`。keepwarm 本身采用 MIT 许可，见 `LICENSE`。
