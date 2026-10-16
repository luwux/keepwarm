// keepwarm: an idle-session guard for the 1-hour prompt cache.
//
// 1. Context reminder: ~50 minutes after the last request, if the context is
//    large, a tool-less fork of the session's own transcript (billed at the
//    cache-read rate, written nowhere, and refreshing the cache as it reads)
//    judges whether to compact, keep warm or ignore. The verdict shows as a band
//    above the prompt with buttons, a toast and a macOS notification; per-project
//    policy can apply it automatically.
// 2. Keep-warm: the same fork, sent when 55 minutes have passed since the last
//    request, inside a window. The person's /keepwarm on 8h holds for its hours
//    whatever happens; the model may also start one with the
//    mcp__keepwarm__keepwarm tool, and the person's /keepwarm overrides the model.
//
// Keep-warm is derived from cache-tax (MIT, Karan Bansal, github.com/karanb192/cache-tax).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { KeepwarmAdvice, KeepwarmLeaveAll, KeepwarmLeaveItem } from '../types'

const TTL_MS = 60 * 60 * 1000
// Cross-session: every session's keepwarm polls the shared $.store for a leave request.
const POLL_MS = 10_000
const LEAVE_COLLECT_MS = 45_000
const LEAVE_REQ_TTL_MS = 10 * 60 * 1000
const RT_KEEP_MS = 3 * 24 * 60 * 60 * 1000
// Settings the person picks in /config (plugin.json userConfig); register() fills them in.
type Idle = 'off' | 'notify' | 'judge'
const cfg = {
  // A JSON file {"server": "https://ntfy.sh", "topic": "..."}; empty means no phone push.
  ntfyConfigFile: '',
  // Below this a session is left alone: no judge, no ping, no compaction; it keeps its whole
  // context and pays a rewrite when the person comes back late. The person's choice (10-16), from
  // 100K: over fifteen days handling the 100-200K band saved about $107 against 48 compactions.
  remindMinCtx: 200_000,
  awayIdleS: 5 * 60,
  // A safety net against a runaway timer: per session, at most pingLimit pings in any
  // pingLimitHours (one every 55 minutes is 13 in 12 hours).
  pingLimit: 15,
  pingLimitHours: 12,
  // What keepwarm may spend a day on its own (idle judges, pings of windows the model opened);
  // past it the idle check falls back to the free notice until midnight. 0: no limit.
  dailyBudgetUsd: 10,
  idleDefault: 'notify' as Idle,
  // Desktop sidebar groups (lower case) whose sessions get no idle check: chats used once and left.
  skipGroups: ['chat'],
  // Nor do sessions with no project, which run in a folder the app made for them (the + beside
  // "This computer" in the sidebar): the person's real chats (10-14).
  skipScratch: true,
}
// Ping when the hour has five minutes left, whatever the session is doing (working, waiting on
// background work, waiting on the person): only the time since the last request counts.
const PING_AFTER_MS = 55 * 60 * 1000
const CHECK_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const DEFAULT_WINDOW_MS = 3 * 60 * 60 * 1000
const MAX_WINDOW_MS = 12 * 60 * 60 * 1000
const MIN_CTX = 30_000
const END_WARN_MS = 10 * 60 * 1000
// Hard brakes on pings, whatever the timers say.
const PING_MIN_GAP_MS = 40 * 60 * 1000
// A wakeup the session scheduled itself (ScheduleWakeup, /loop) refreshes the cache with its own
// request: no idle check and no ping while one is due this long before the cache lapses.
const WAKE_MARGIN_MS = 3 * 60 * 1000
// An idle session the judge wants kept warm stays warm until this long after its last turn, then
// is compacted. Two weeks of history (research/10-keepwarm-backlog.md, 10-14): daytime returns
// come within six hours or the next day, and up to six hours the pings cost about what the
// compactions they spare save.
const KEEP_UNTIL_MS = 6 * 60 * 60 * 1000
// A session waiting on background work it started (a shell, a subagent, a monitor) is woken by
// that work when it reports, whoever is around: it stays warm until then, with no judge, at most
// this long after its last turn, and is then compacted. Fifteen days of history
// (research/10-keepwarm-backlog.md, 10-14): 80% of such waits report within 6 hours, 92% in 12.
const BG_KEEP_MS = 12 * 60 * 60 * 1000
// A background shell that starts by sleeping is the session's own alarm clock: sessions use
// `sleep 3300` because ScheduleWakeup fires only under /loop.
const SELF_WAKE = /^\s*sleep\s+(\d+(?:\.\d+)?)\s*(?:$|[;&|\n])/
// A watch on a published artifact ("live updates for artifact …") is listed as background work but
// runs until stopped and reports only if someone comments: no sign the session will be woken
// (10-16: two sessions kept warm twelve hours overnight for one).
const WATCH = /^live updates for /i
const GUARD_MIN_CTX = 50_000
const PING_PROMPT = 'Reply with the single word: warm'
const TOOL = 'mcp__keepwarm__keepwarm'
const NOT_THE_PERSON = new Set(['plugin', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'slack-ping', 'projects-relay', 'channel'])
const LOG_MAX = 500

// $ per million tokens: [cache read, 1h cache write, output], list prices September 2026.
// Longer family names first: a model id matches the first row it contains.
const PRICES: Array<[string, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

type Owner = 'user' | 'model'
type Policy = 'ask' | 'auto' | 'warm' | 'off'
type Guard = 'refuse' | 'warn' | 'off'
// Why a request rewrote the cache: the hour lapsed, the model changed, or something else
// changed the prompt's prefix (system prompt, tool list).
type MissCause = 'expired' | 'model' | 'other'
type Miss = { at: number; tokens: number; usd: number | null; cause: MissCause; gapMs: number }
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Timer = { cancel: () => void }

type State = {
  sid: string
  cwd: string
  policy: Policy
  guard: Guard
  ackedAt: number
  // What the last main-loop request carried, and on which model: the next one is held to it.
  stepCtx: number
  stepModel: string | null
  // The first request after a compaction writes the summary; that is not a miss.
  skipMiss: boolean
  // What started the current turn: 'person', or the origin of a turn nobody typed.
  turnBy: string
  misses: Miss[]
  deadline: number
  every: number
  owner: Owner | null
  reason: string
  wakePrompt: string
  userOff: boolean
  // Opened with /keepwarm on: it holds for its hours whatever the person does, and only
  // /keepwarm off ends it. A window from a reminder or the model covers an absence, so it ends
  // when the person writes.
  sticky: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  window: number
  compacted: boolean
  compactions: number // seen since this load: a command worked when it went up
  turnError: boolean // the last main turn died on an API error (a usage limit, say)
  pending: Timer | null
  check: Timer | null
  expire: Timer | null
  endWarn: Timer | null
  endWarnedFor: number
  tick: Timer | null
  caff: AsyncGenerator<unknown, unknown> | null
  checkedFor: number
  // Last real turn. Forks refresh lastRequestAt but are not the person coming back.
  turnAt: number
  poll: Timer | null
  collect: Timer | null
  leaveSeen: string
  // The 50-minute idle check: off, a free notice, or a judging fork.
  idle: Idle
  last: PingRecord | null
  pings: number
  pingUsd: number
  stopped: string | null
  // The panel (/keepwarm panel) redraws its countdown each minute while open.
  paneTick: Timer | null
  // Buttons on a phone push: polling the reply topic while one of them may still be tapped.
  phonePoll: Timer | null
  phoneBusy: boolean
  // The window was opened by the idle judge: when it runs out, compact.
  thenCompact: boolean
  // When the session's own scheduled wakeup fires next (ScheduleWakeup, a sleeping background
  // shell); 0 when none is known.
  wakeAt: number
  wakeBySleep: boolean
  // The background work still running when the main thread last stopped, as the engine lists it:
  // it wakes the session when it reports.
  bg: string[]
}

const advice = atom({ plugin: 'keepwarm', key: 'advice' } as const, null as KeepwarmAdvice | null)
const leaveAll = atom({ plugin: 'keepwarm', key: 'leaveAll' } as const, null as KeepwarmLeaveAll | null)
const panel = atom({ plugin: 'keepwarm', key: 'panel' } as const, 0)

type LeaveReq = { id: string; at: number; from: string; hours: number; machineOn: boolean }
type Runtime = { lastRequestAt: number; turnAt: number; ctx: number; window: number; model: string | null; compacted: boolean }

function priceOf(model: string | null): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, r, w, o] of PRICES) if (m.includes(family)) return [r, w, o]
  return null
}

function parseDuration(text: string): number | null {
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

const fmtUsd = (usd: number | null) => usd == null ? 'n/a' : '$' + (usd >= 10 ? usd.toFixed(1) : usd.toFixed(2))
const fmtTok = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n)
const coldUsd = (s: State) => { const p = priceOf(s.lastModel); return p ? s.ctx * p[1] / 1e6 : null }
const hourUsd = (s: State) => { const p = priceOf(s.lastModel); return p ? s.ctx * p[0] / 1e6 * (TTL_MS / s.every) : null }
const isCold = (s: State, now: number) => s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
const key = (s: State, k: string) => `${k}:${s.sid}`
const project = (s: State) => s.cwd.split('/').filter(Boolean).pop() ?? s.cwd

function forkUsd(u: Usage, p: [number, number, number] | null): number | null {
  return p ? (u.cache_read_input_tokens * p[0] + u.cache_creation_input_tokens * p[1] + u.input_tokens * p[1] / 2 + u.output_tokens * p[2]) / 1e6 : null
}

// A warm fork reads the prefix and writes only its own tail; a big write means the prefix broke.
const forkWasWarm = (u: Usage) => u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens

// Nothing under the prompt, warm or cold (10-14): a rewrite is told by a notice when it
// happens, and /keepwarm shows the rest.
function statusText(_s: State, _now: number): string | undefined {
  return undefined
}

// Each label is two Chinese characters and a full-width space, so the lines stay aligned in the
// desktop app's proportional font as well as in a terminal.
async function card($: EngineInterface, s: State, now: number): Promise<string> {
  const alertOn = (await $.store.get('alert')) === true
  const spent = await spendToday($, now)
  const over = await overBudget($)
  const cache = !s.lastRequestAt ? '本会话还没有请求'
    : s.compacted ? '刚 compact，等下一轮'
    : isCold(s, now) ? `已冷（最后请求在 ${fmtDuration(now - s.lastRequestAt)} 前）`
    : `热，还剩 ${fmtDuration(s.lastRequestAt + TTL_MS - now)}`
  const warm = s.deadline
    ? `开，还剩 ${fmtDuration(s.deadline - now)}（${s.sticky ? '/keepwarm on 开的，发消息不会结束' : `${s.owner === 'model' ? '模型' : '你'}开的，你回来发消息就结束`}）` +
      `${s.reason && !s.sticky ? `：${s.reason}` : ''}${s.wakePrompt ? `；唤醒任务：${s.wakePrompt}` : ''}`
    : s.stopped ? `关（上次停止：${s.stopped}）` : '关'
  const remind = s.policy === 'off' || s.idle === 'off' ? '关'
    : wakesItself(s, now) ? `会话定好了 ${fmtDuration(s.wakeAt - now)} 后自己醒来，不用提醒`
    : s.check && s.bg.length ? `${s.bg.length} 个后台任务在跑：空闲 50 分钟时开始保温到它们回报（最长到空闲 ${fmtDuration(BG_KEEP_MS)}）`
    : s.check ? `空闲 50 分钟时${s.idle === 'judge' && !over ? `判断一次，然后自己 compact、保温到空闲 ${fmtDuration(KEEP_UNTIL_MS)} 后 compact，或不管` : '免费提醒一次'}`
    : s.deadline ? '保温期间不提醒'
    : `不提醒（上下文不到 ${fmtTok(cfg.remindMinCtx)}，或缓存已冷）`
  const missUsd = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  return [
    `${project(s)}（项目策略 ${s.policy}）`,
    '',
    `缓存　${cache} · 上下文 ${fmtTok(s.ctx)} / ${fmtTok(s.window)} · ${s.lastModel ?? '模型未知'}`,
    `保温　${warm}${s.userOff ? '；你已禁止模型开启' : ''}`,
    `提醒　${remind}`,
    `价格　过期后重写一次约 ${fmtUsd(coldUsd(s))}，保温约 ${fmtUsd(hourUsd(s))}/小时`,
    `记账　本会话冷写入 ${s.misses.length} 次 ${fmtUsd(missUsd)} · 本次运行 ping ${s.pings} 次 ${fmtUsd(s.pingUsd)}` +
      `${s.last ? `（上次读 ${fmtTok(s.last.read)}、写 ${fmtTok(s.last.write)}）` : ''}`,
    `今天　keepwarm 共花 ${fmtUsd(spent.auto + spent.manual)}：自己主动的 ${fmtUsd(spent.auto)}` +
      `${cfg.dailyBudgetUsd ? `（上限 $${cfg.dailyBudgetUsd}${over ? '，已超，今天不再自动判断' : ''}）` : ''}，你要求的 ${fmtUsd(spent.manual)}`,
    `报警　${alertOn ? '开' : '关'}`,
    `设置　空闲检查 ${s.idle} · 提醒门槛 ${fmtTok(cfg.remindMinCtx)} · ping 上限 ${cfg.pingLimit} 次/${cfg.pingLimitHours} 小时 · ` +
      `冷发送${{ refuse: '先拦一次', warn: '只记账', off: '不管' }[s.guard]} · 项目策略 ${s.policy} · 手机推送${cfg.ntfyConfigFile ? `开（离开 ${cfg.awayIdleS / 60} 分钟后）` : '关'}`,
    '',
    '常用　/keepwarm on 8h · off · check · alert on · log · help',
  ].join('\n')
}

const HELP = [
  '/keepwarm 的用法',
  '',
  'on 8h：保温 8 小时（也可以写 90m），不管会话在干什么、你发什么消息，只有 off 能关',
  'off：关掉保温，并禁止模型自己开；auto：重新允许模型自己开',
  'status：看状态（直接输入 /keepwarm 也是）',
  'check：现在判断一次：compact、保温还是不管',
  'leave 2h on|off：告诉所有会话你要离开多久（on 电脑开着，off 合盖或关机）',
  'idle off|notify|judge：空闲 50 分钟时什么都不做 / 免费提醒 / 判断一次',
  'alert on|off|test：报警开关；test 发一条测试报警',
  'policy auto|warm|off：本项目空闲时按判断自动处理 / 总是保温 / 不管（ask 同 auto）',
  'guard refuse|warn|off：缓存已冷还发消息时先拦一次 / 只记账 / 不管',
  'log [all] [requests|changes]：审计记录；ledger：冷写入账本',
  'push：发一条带按钮的测试推送到手机（真实提醒在你离开 Mac 时才推，带 compact / 保温 / 不管 按钮）',
  'panel：打开按钮面板（compact / 保温 / 关保温）',
].join('\n')

// ---------- audit: every request keepwarm pays for and every change it makes ----------
// All side effects go through the audited* helpers below; nothing else calls $.model, $.mcp,
// $.prompt.submit, $.session.compact/append or spawns a process that changes anything.
const AUDIT_MAX = 3000
type ForkResult = Awaited<ReturnType<EngineInterface['model']['fork']>>
type CompleteResult = Awaited<ReturnType<EngineInterface['model']['complete']>>
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

async function audit($: EngineInterface, s: State, kind: 'request' | 'change' | 'notify', what: string, data: Record<string, unknown> = {}) {
  try {
    const log = ((await $.store.get('audit')) as unknown[] | undefined) ?? []
    log.push({ at: await $.clock.now(), sid: s.sid, kind, what, ...data })
    await $.store.set('audit', log.slice(-AUDIT_MAX))
  } catch (err) {
    $.ui.log(`keepwarm：审计记录写入失败 ${errText(err)}`)
  }
}

// manual: the person asked for this request (their window's ping, /keepwarm check, a leave);
// everything else counts against the daily budget.
async function auditedFork($: EngineInterface, s: State, purpose: string, prompt: string, manual = false): Promise<ForkResult> {
  let r: ForkResult
  try {
    r = await $.model.fork({ prompt })
  } catch (err) {
    await audit($, s, 'request', purpose, { via: 'fork', model: s.lastModel, manual, error: errText(err) })
    throw err
  }
  const u = 'usage' in r ? (r.usage as Usage) : null
  await audit($, s, 'request', purpose, {
    via: 'fork', model: s.lastModel, manual, answered: r.isAnswered, reason: r.isAnswered ? undefined : r.reason,
    read: u?.cache_read_input_tokens ?? 0, write: u?.cache_creation_input_tokens ?? 0, in: u?.input_tokens ?? 0, out: u?.output_tokens ?? 0,
    usd: u ? forkUsd(u, priceOf(s.lastModel)) : 0,
  })
  return r
}

async function auditedComplete($: EngineInterface, s: State, purpose: string, model: string, prompt: string, maxTokens: number, price: [number, number]): Promise<CompleteResult> {
  let r: CompleteResult
  try {
    r = await $.model.complete({ model, prompt, maxTokens })
  } catch (err) {
    await audit($, s, 'request', purpose, { via: 'complete', model, error: errText(err) })
    throw err
  }
  const u = 'usage' in r ? (r.usage as { input_tokens: number; output_tokens: number }) : null
  await audit($, s, 'request', purpose, {
    via: 'complete', model, answered: r.isAnswered, reason: r.isAnswered ? undefined : r.reason,
    in: u?.input_tokens ?? 0, out: u?.output_tokens ?? 0, usd: u ? (u.input_tokens * price[0] + u.output_tokens * price[1]) / 1e6 : 0,
  })
  return r
}

async function auditedMcp($: EngineInterface, s: State, purpose: string, server: string, tool: string, args: Record<string, unknown>) {
  try {
    const r = await $.mcp.call(server, tool, args)
    await audit($, s, 'change', purpose, { server, tool, args, ok: !r.isError, result: r.isError ? JSON.stringify(r.content).slice(0, 300) : undefined })
    return r
  } catch (err) {
    await audit($, s, 'change', purpose, { server, tool, args, ok: false, error: errText(err) })
    throw err
  }
}

// A process that changes something (a notification, a push, a file write or delete).
async function auditedRun($: EngineInterface, s: State, kind: 'change' | 'notify', purpose: string, argv: readonly string[], detail: Record<string, unknown> = {}) {
  try {
    const r = await $.process.run(argv)
    await audit($, s, kind, purpose, { ...detail, exit: r.exitCode })
    return r
  } catch (err) {
    await audit($, s, kind, purpose, { ...detail, ok: false, error: errText(err) })
    throw err
  }
}

async function auditedSubmit($: EngineInterface, s: State, purpose: string, text: string) {
  try {
    await $.prompt.submit({ text })
    await audit($, s, 'change', purpose, { text: text.slice(0, 500) })
  } catch (err) {
    await audit($, s, 'change', purpose, { text: text.slice(0, 500), ok: false, error: errText(err) })
    throw err
  }
}

async function auditedCompact($: EngineInterface, s: State) {
  try {
    await $.session.compact()
    await audit($, s, 'change', 'compact', {})
  } catch (err) {
    await audit($, s, 'change', 'compact', { ok: false, error: errText(err) })
    throw err
  }
}

// A slash command run as the user would type it (the desktop app compacts only this way).
async function auditedCommand($: EngineInterface, s: State, purpose: string, command: string, args: string) {
  const n = s.compactions
  try {
    const r = await $.command.run({ command, args })
    await audit($, s, 'change', purpose, { command, args: args.slice(0, 500), text: r.text?.slice(0, 300), compacted: s.compactions > n })
    return r
  } catch (err) {
    await audit($, s, 'change', purpose, { command, args: args.slice(0, 500), ok: false, error: errText(err) })
    throw err
  }
}

async function appendLog($: EngineInterface, name: string, row: Record<string, unknown>) {
  const log = ((await $.store.get(name)) as unknown[] | undefined) ?? []
  log.push(row)
  await $.store.set(name, log.slice(-LOG_MAX))
}

// Seconds since the last keyboard or mouse input on this Mac.
async function idleSeconds($: EngineInterface): Promise<number> {
  try {
    const r = await $.process.run(['ioreg', '-c', 'IOHIDSystem', '-d', '4'])
    const m = /"HIDIdleTime" = (\d+)/.exec(r.stdout)
    return m ? Number(m[1]) / 1e9 : 0
  } catch {
    return 0
  }
}

// A dark wake: the lid is closed and the Mac wakes for a few seconds of maintenance, then sleeps
// again. A request sent then is cut by the sleep and retried on the next full wake, maybe after
// the cache has lapsed (10-15: a judge sent at 12:23 went out again at 12:54 and wrote 404K
// tokens, $3.25). A full wake has graphics; a display that is merely off keeps them.
async function darkWake($: EngineInterface): Promise<boolean> {
  try {
    const r = await $.process.run(['pmset', '-g', 'systemstate'])
    return /Capabilities are:/.test(r.stdout) && !/Graphics/.test(r.stdout)
  } catch {
    return false
  }
}

// A desktop notification always; the phone too when nobody is at the Mac.
async function alert($: EngineInterface, s: State, title: string, message: string, buttons: PhoneButton[] = []) {
  await notify($, s, title, message)
  if ((await idleSeconds($)) < cfg.awayIdleS) return
  const c = await ntfyConfig($)
  const actions = c ? await phoneActions($, s, buttons, c) : []
  // The phone shows the session's own title (as the desktop sidebar does), not the folder.
  await push($, s, `${await sessionName($, s)} · ${title}`,
    message + (actions.length ? '\n\n点下面的按钮，Mac 上的这个会话约半分钟内照做，做完再推一条确认。' : '\n\n要处理请回到会话里。'), actions)
}

const sessionName = async ($: EngineInterface, s: State) => (await desktopSession($, s))?.title || project(s)

// ---------- the panel (/keepwarm panel): the same buttons as the band, in a pane ----------

const PANE = 'keepwarm'

async function openPanel($: EngineInterface, s: State) {
  const r = await $.ui.open({ id: PANE, title: 'keepwarm' })
  // The countdown moves with the clock, not with any value the drawing reads.
  if (s.paneTick) s.paneTick.cancel()
  s.paneTick = $.clock.every(60_000, () => { void update($, panel, n => n + 1) })
  return r
}

type PanelChoice = 'compact' | 'advised' | 'warm8' | 'off' | 'ignore'

async function panelPress($: EngineInterface, s: State, choice: PanelChoice) {
  const now = await $.clock.now()
  const stored = await read($, advice)
  const a = stored && !adviceStale(stored, now) ? stored : null
  await audit($, s, 'change', '面板按钮', { choice, advised: a?.action ?? null })
  if (choice === 'compact') {
    await apply($, s, a ?? { action: 'compact', reason: '面板上手动 compact', topic: '', hours: 3, ctx: s.ctx, coldUsd: coldUsd(s), hourUsd: hourUsd(s), judgeUsd: null, at: now, auto: false }, 'compact', 'user')
  } else if (choice === 'advised' && a) {
    await apply($, s, a, 'keepwarm', 'user')
  } else if (choice === 'ignore' && a) {
    await apply($, s, a, 'ignore', 'user')
  } else if (choice === 'warm8') {
    // The same as /keepwarm on 8h: it holds whatever happens, until off.
    if (a) {
      await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: a.ctx, advised: a.action, reason: a.reason, chosen: 'keepwarm', by: 'user' })
      await update($, advice, () => null)
    }
    s.userOff = false
    await startWindow($, s, 8 * 3_600_000, 'user', '面板：保温 8h', '', true)
  } else if (choice === 'off') {
    await stop($, s, '你在面板上关了保温')
  }
  $.ui.status(statusText(s, await $.clock.now()))
  await update($, panel, n => n + 1)
}

// ---------- buttons on a phone push ----------
// Each button is an ntfy http action that posts a one-time token to the reply topic. Only this
// session honours its tokens, each notification once (one tap spends all its buttons), and only
// for PHONE_KEEP_MS; the session polls the topic (a GET) while any of its tokens is live.

type PhoneChoice = { kind: 'compact' } | { kind: 'warm'; hours: number } | { kind: 'ignore' }
type PhoneButton = { label: string; choice: PhoneChoice }
type PhoneToken = { token: string; group: string; choice: PhoneChoice; at: number; exp: number }
type NtfyAction = { action: 'http'; label: string; url: string; method: 'POST'; body: string; clear: true }

const PHONE_POLL_MS = 20_000
const PHONE_KEEP_MS = 3 * 3_600_000

const warmButton = (hours: number, verb = '保温'): PhoneButton => ({ label: `${verb} ${hours}h`, choice: { kind: 'warm', hours } })
const COMPACT_BUTTON: PhoneButton = { label: 'compact', choice: { kind: 'compact' } }
const IGNORE_BUTTON: PhoneButton = { label: '不管', choice: { kind: 'ignore' } }

async function phoneTokens($: EngineInterface, s: State): Promise<PhoneToken[]> {
  const v = await $.store.get(key(s, 'phone'))
  return Array.isArray(v) ? (v as PhoneToken[]) : []
}

async function setPhoneTokens($: EngineInterface, s: State, list: PhoneToken[]) {
  if (list.length) await $.store.set(key(s, 'phone'), list)
  else await $.store.delete(key(s, 'phone'))
}

async function phoneActions($: EngineInterface, s: State, buttons: PhoneButton[], c: Ntfy): Promise<NtfyAction[]> {
  if (!c.reply || !buttons.length) return []
  const now = await $.clock.now()
  const group = crypto.randomUUID()
  const fresh = buttons.slice(0, 3).map(b => ({ label: b.label, t: { token: crypto.randomUUID().replace(/-/g, ''), group, choice: b.choice, at: now, exp: now + PHONE_KEEP_MS } }))
  await setPhoneTokens($, s, [...(await phoneTokens($, s)).filter(t => t.exp > now), ...fresh.map(f => f.t)])
  armPhonePoll($, s)
  return fresh.map(({ label, t }) => ({ action: 'http', label, url: `${c.server}/${c.reply}`, method: 'POST', body: JSON.stringify({ keepwarm: t.token }), clear: true }))
}

function armPhonePoll($: EngineInterface, s: State) {
  if (!s.phonePoll) s.phonePoll = $.clock.every(PHONE_POLL_MS, () => { void pollPhone($, s) })
}

// The taps since the oldest live token was handed out: a GET on the reply topic, nothing written.
async function readReplies($: EngineInterface, c: Ntfy, since: number): Promise<{ id: string; token: string }[]> {
  const r = await $.process.run(['curl', '-s', '-m', '10', `${c.server}/${c.reply}/json?poll=1&since=${since}`])
  const out: { id: string; token: string }[] = []
  for (const line of r.stdout.split('\n')) {
    try {
      const m = JSON.parse(line) as { id?: string; event?: string; message?: string }
      const b = JSON.parse(m.message ?? '') as { keepwarm?: unknown }
      if (m.event === 'message' && m.id && typeof b.keepwarm === 'string') out.push({ id: m.id, token: b.keepwarm })
    } catch {
      // another sender's message on the topic, or a partial line
    }
  }
  return out
}

async function pollPhone($: EngineInterface, s: State) {
  if (s.phoneBusy) return
  s.phoneBusy = true
  try {
    const now = await $.clock.now()
    const live = (await phoneTokens($, s)).filter(t => t.exp > now)
    if (!live.length) {
      if (s.phonePoll) s.phonePoll.cancel()
      s.phonePoll = null
      await setPhoneTokens($, s, [])
      return
    }
    const c = await ntfyConfig($)
    if (!c?.reply) return
    const since = Math.floor(Math.min(...live.map(t => t.at)) / 1000) - 5
    for (const r of await readReplies($, c, since)) {
      const tokens = await phoneTokens($, s)
      const t = tokens.find(x => x.token === r.token && x.exp > now)
      if (!t) continue
      await setPhoneTokens($, s, tokens.filter(x => x.group !== t.group))
      await phoneDo($, s, t.choice)
    }
  } catch (err) {
    $.ui.log(`keepwarm：读手机按钮失败 ${errText(err)}`, { to: 'debug' })
  } finally {
    s.phoneBusy = false
  }
}

async function phoneDo($: EngineInterface, s: State, choice: PhoneChoice) {
  const now = await $.clock.now()
  const stored = await read($, advice)
  const a = stored && !adviceStale(stored, now) ? stored : null
  await audit($, s, 'change', '手机通知按钮', { choice, advised: a?.action ?? null })
  const name = await sessionName($, s)
  if (choice.kind === 'ignore') {
    if (a) await apply($, s, a, 'ignore', 'user')
    return
  }
  if (s.compacted) {
    await push($, s, `${name} · 已经 compact 过了`, '这次按钮没有执行。')
    return
  }
  if (isCold(s, now)) {
    const late = `缓存在 ${fmtDuration(now - s.lastRequestAt - TTL_MS)} 前已经过期，`
    await push($, s, `${name} · 缓存已过期，没执行`, choice.kind === 'compact'
      ? `${late}现在 compact 要重新读整段上下文（约 ${fmtUsd(coldUsd(s))}），回到会话里再决定。`
      : `${late}保温已经没有意义。`)
    return
  }
  if (choice.kind === 'compact') {
    const before = s.ctx
    const n = s.compactions
    await apply($, s, a ?? { action: 'compact', reason: '手机通知上的 compact', topic: '', hours: 3, ctx: s.ctx, coldUsd: coldUsd(s), hourUsd: hourUsd(s), judgeUsd: null, at: now, auto: false }, 'compact', 'user')
    const done = s.compactions > n
    await push($, s, `${name} · ${done ? '已 compact' : 'compact 没成功'}`,
      done ? `原来上下文 ${fmtTok(before)}，下一轮从摘要开始。` : '回到会话里手动 /compact。')
    return
  }
  if (a) {
    await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: a.ctx, advised: a.action, reason: a.reason, chosen: 'keepwarm', by: 'user' })
    await update($, advice, () => null)
  }
  s.userOff = false
  // Like a reminder's button: it covers the absence, so it ends when you write in the session.
  await startWindow($, s, choice.hours * 3_600_000, 'user', `手机通知：保温 ${choice.hours}h`)
  await push($, s, `${name} · 已保温 ${choice.hours}h`, `约 ${fmtUsd(hourUsd(s))}/小时；你回来在这个会话里发消息，保温就结束。`)
}

// ---------- alerts: only what should not have happened, opt-in (/keepwarm alert on) ----------

type AlarmKind = 'lapsed' | 'unexplained' | 'budget' | 'pinglimit' | 'compactfail'
const ALARM_GAP_MS = 60 * 60 * 1000

const dayStart = (now: number) => {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// To the Mac (and the phone when you are away), at most once an hour per kind and session.
async function alarm($: EngineInterface, s: State, kind: AlarmKind, title: string, message: string) {
  if ((await $.store.get('alert')) !== true) return
  const now = await $.clock.now()
  const seen = ((await $.store.get('alarms')) as Record<string, number> | undefined) ?? {}
  const k = `${kind}:${kind === 'budget' ? '' : s.sid}`
  if (now - (seen[k] ?? 0) < ALARM_GAP_MS) return
  const kept: Record<string, number> = {}
  for (const [key, at] of Object.entries(seen)) if (now - at < 24 * 3_600_000) kept[key] = at
  kept[k] = now
  await $.store.set('alarms', kept)
  await alert($, s, `⚠️ ${title}`, message)
}

// What keepwarm spent today, split into what it chose to spend and what the person asked for.
// Only the first has a budget: pausing the second would undo what they asked for, and with many
// sessions each kept warm on purpose the total grows past any fixed line. The person's own
// windows are bounded per session by pingLimit instead.
async function spendToday($: EngineInterface, now: number): Promise<{ auto: number; manual: number }> {
  const from = dayStart(now)
  const log = ((await $.store.get('audit')) as Array<{ at: number; kind: string; usd?: number; manual?: boolean }> | undefined) ?? []
  const out = { auto: 0, manual: 0 }
  for (const r of log) if (r.at >= from && r.kind === 'request') out[r.manual ? 'manual' : 'auto'] += r.usd ?? 0
  return out
}

async function overBudget($: EngineInterface): Promise<boolean> {
  return cfg.dailyBudgetUsd > 0 && (await $.store.get('budgetHit')) === dayStart(await $.clock.now())
}

async function checkBudget($: EngineInterface, s: State) {
  if (!cfg.dailyBudgetUsd || (await overBudget($))) return
  const now = await $.clock.now()
  const spent = (await spendToday($, now)).auto
  if (spent <= cfg.dailyBudgetUsd) return
  await $.store.set('budgetHit', dayStart(now))
  await audit($, s, 'change', '今日自动花费超过上限', { spent, budget: cfg.dailyBudgetUsd })
  const msg = `keepwarm 今天自己花了 ${fmtUsd(spent)}（上限 $${cfg.dailyBudgetUsd}），午夜前空闲检查改为免费提醒；你开的保温照常。`
  $.ui.toast(msg)
  await alarm($, s, 'budget', '自动花费超过上限', msg)
}

async function alertLine($: EngineInterface, now: number): Promise<string> {
  const on = (await $.store.get('alert')) === true
  const spent = await spendToday($, now)
  const over = await overBudget($)
  return `alerts      报警${on ? '开' : '关'}（/keepwarm alert on|off|test）\n` +
    `today       keepwarm 今天共花 ${fmtUsd(spent.auto + spent.manual)}：自己主动的 ${fmtUsd(spent.auto)}${cfg.dailyBudgetUsd ? `（上限 $${cfg.dailyBudgetUsd}${over ? '，已超，今天不再自动判断' : ''}）` : ''}，` +
    `你要求的 ${fmtUsd(spent.manual)}（你开的保温、check、离开判断；不设上限，每会话 ${cfg.pingLimitHours} 小时最多 ping ${cfg.pingLimit} 次）`
}

// The desktop app names its sessions local_<uuid>; its deep link wants that id, and
// its record maps it to the CLI session id this mod knows.
const DESKTOP_SESSIONS = '$HOME/Library/Application Support/Claude/claude-code-sessions'

async function desktopSession($: EngineInterface, s: State): Promise<{ id: string; title: string } | null> {
  try {
    // The pattern goes in as an argument: quotes written inside this template literal would be
    // eaten by JS and then by sh, and grep would search for cliSessionId:<id> and never match.
    const r = await $.process.run(['sh', '-c', `f=$(grep -rl --include='local_*.json' -F -e "$1" "${DESKTOP_SESSIONS}" 2>/dev/null | head -1) && [ -n "$f" ] && cat "$f"`, 'kw', `"cliSessionId":"${s.sid}"`])
    const d = JSON.parse(r.stdout) as { sessionId?: string; cliSessionId?: string; title?: string }
    return d.cliSessionId === s.sid && d.sessionId?.startsWith('local_') ? { id: d.sessionId, title: d.title ?? '' } : null
  } catch {
    return null
  }
}

// The folder the desktop app makes for a session started with no project.
const SCRATCH = /\/Library\/Application Support\/Claude\/scratch-workspaces\//
const DESKTOP_CONFIG = '$HOME/Library/Application Support/Claude/claude_desktop_config.json'

// The desktop sidebar group this session is filed under, by name; '' when none (or not the app).
async function sidebarGroup($: EngineInterface, s: State): Promise<string> {
  const ds = await desktopSession($, s)
  if (!ds) return ''
  try {
    const r = await $.process.run(['sh', '-c', `cat "${DESKTOP_CONFIG}"`])
    type Scope = { groups?: Array<{ id: string; name: string }>; assignments?: Record<string, string> }
    const scopes = ((JSON.parse(r.stdout) as { preferences?: { epitaxyPrefs?: Record<string, unknown> } })
      .preferences?.epitaxyPrefs?.['dframe-group-scopes'] ?? {}) as Record<string, Scope>
    for (const scope of Object.values(scopes)) {
      const id = scope.assignments?.[`code:${ds.id}`]
      const group = id ? scope.groups?.find(g => g.id === id) : undefined
      if (group) return group.name
    }
  } catch { /* no desktop app config */ }
  return ''
}

async function notify($: EngineInterface, s: State, title: string, message: string) {
  $.ui.toast(`${title}：${message}`)
  try {
    // The desktop app runs sessions headless, so surfaces() may not say 'desktop':
    // the app's own record of this session is the test.
    const ds = await desktopSession($, s)
    $.ui.log(`keepwarm notify: surfaces=${(await $.session.surfaces()).join(',') || '-'} desktop=${ds?.id ?? 'none'}`, { to: 'debug' })
    const argv = ['terminal-notifier', '-title', 'Claude Code', '-subtitle', `${ds?.title || project(s)} · ${title}`, '-message', message, '-group', `keepwarm-${s.sid}`]
    // Clicking opens this very session in the desktop app.
    // Bring the app forward first: a link to the session already on screen changes nothing by itself.
    if (ds) argv.push('-execute', `open -b com.anthropic.claudefordesktop && open 'claude://code/continue?session=${ds.id}&source=desktop_action'`)
    await auditedRun($, s, 'notify', 'Mac 通知', argv, { title, message: message.slice(0, 200), jump: ds?.id ?? null })
  } catch {
    // terminal-notifier missing or refused: the toast and band still show.
  }
}

// ---------- cold-send guard (from cache-tax) ----------

function guardText(s: State, now: number): string {
  const p = priceOf(s.lastModel)
  const warm = p ? s.ctx * p[0] / 1e6 : null
  return `缓存已冷 ${fmtDuration(now - s.lastRequestAt - TTL_MS)}（最后请求在 ${fmtDuration(now - s.lastRequestAt)} 前）。` +
    `这次发送要重写约 ${fmtTok(s.ctx)} tokens，约 ${fmtUsd(coldUsd(s))}（热的话只要 ${fmtUsd(warm)}）。`
}

const MISS_ZH = { expired: '缓存过期', model: '换了模型', other: '提示前缀变了' } as const

// Judged per request, not per turn: a long turn whose context grows step by step writes a lot
// in total and is not a miss, while a rewrite in the middle of a turn (after a foreground
// subagent that ran past the hour) is one.
async function checkMiss($: EngineInterface, s: State, u: TurnUsage, prevAt: number) {
  const prev = s.stepCtx || s.ctx
  const read = u.cache_read_input_tokens
  const write = u.cache_creation_input_tokens
  const prevModel = s.stepModel ?? s.lastModel
  s.stepCtx = read + write + u.input_tokens
  s.stepModel = u.model
  // The summary of a compaction is written afresh by design.
  if (s.skipMiss) {
    s.skipMiss = false
    return
  }
  // Nothing was cached yet (a new session's first message, prev is 0), or no rewrite.
  if (prev <= 20000 || read >= 0.5 * prev || write < 0.5 * prev) return
  const now = await $.clock.now()
  const gapMs = prevAt ? now - prevAt : 0
  // No last request known: an old session reopened after its record was dropped.
  const cause: MissCause = prevModel && prevModel !== u.model ? 'model' : !prevAt || gapMs > TTL_MS ? 'expired' : 'other'
  const p = priceOf(u.model)
  const miss: Miss = { at: now, tokens: write, usd: p ? write * p[1] / 1e6 : null, cause, gapMs }
  s.misses.push(miss)
  await appendLog($, 'misses', { sid: s.sid, cwd: s.cwd, model: u.model, ...miss })
  // Every real rewrite gets a notice in Claude, nothing outside it (asked for 10-14).
  const by = s.turnBy === 'person' ? '' : s.turnBy === 'task-notification' ? '，后台任务回报时' : `，${s.turnBy} 触发`
  const what = `${fmtTok(write)} tokens，约 ${fmtUsd(miss.usd)}`
  $.ui.toast(
    cause === 'other' ? `意外整段重写 ${what}：同一模型、距上次请求只有 ${fmtDuration(gapMs)}，可能是系统提示或工具列表变了${by}`
    : cause === 'expired' && s.deadline ? `保温期间缓存过期，重写 ${what}（距上次请求 ${fmtDuration(gapMs)}${by}）`
    : `冷写入 ${what}（${MISS_ZH[cause]}${prevAt ? `，距上次请求 ${fmtDuration(gapMs)}` : ''}${by}）`,
  )
  if (cause === 'other') {
    await alarm($, s, 'unexplained', '缓存被意外整段重写', `同一模型、距上次请求只有 ${fmtDuration(gapMs)}，仍整段重写了 ${fmtTok(write)} tokens（约 ${fmtUsd(miss.usd)}）。可能是系统提示或工具列表变了，或者回退、编辑了历史消息。`)
  } else if (cause === 'expired' && s.deadline) {
    await alarm($, s, 'lapsed', '保温期间缓存过期', `保温窗口开着，缓存还是过期了：重写 ${fmtTok(write)} tokens（约 ${fmtUsd(miss.usd)}）。看 /keepwarm log 找原因。`)
  }
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

// A window whose pings could not go out (the Mac slept, or this session's process was not
// running after an app restart): the cache lapsed an hour after the last request, inside the
// window. Record it and end the window rather than let it run out silently.
async function lapsedWindow($: EngineInterface, s: State, deadline: number, cause: string) {
  const lostAt = s.lastRequestAt + TTL_MS
  const why = `保温本该到 ${hhmm(deadline)}，但${cause}，缓存约 ${hhmm(lostAt)} 已过期`
  await audit($, s, 'change', '保温中断', { why, deadline, lastRequestAt: s.lastRequestAt, lostAt })
  await alarm($, s, 'lapsed', '保温失效', why)
  if (s.deadline) await stop($, s, why)
  else $.ui.toast(`keepwarm：${why}`)
}

async function missesTotal($: EngineInterface): Promise<{ n: number; usd: number }> {
  const log = ((await $.store.get('misses')) as Array<{ usd: number | null }> | undefined) ?? []
  return { n: log.length, usd: log.reduce((a, m) => a + (m.usd ?? 0), 0) }
}

// ---------- keep-warm window ----------

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
}

function disarmCheck(s: State) {
  if (s.check) s.check.cancel()
  s.check = null
}

async function save($: EngineInterface, s: State) {
  if (s.deadline) {
    await $.store.set(key(s, 'deadline'), s.deadline)
    await $.store.set(key(s, 'owner'), s.owner ?? 'user')
    await $.store.set(key(s, 'reason'), s.reason)
    await $.store.set(key(s, 'wake'), s.wakePrompt)
    await $.store.set(key(s, 'sticky'), s.sticky)
    await $.store.set(key(s, 'thenCompact'), s.thenCompact)
  } else {
    for (const k of ['deadline', 'owner', 'reason', 'wake', 'sticky', 'thenCompact']) await $.store.delete(key(s, k))
  }
  if (s.userOff) await $.store.set(key(s, 'userOff'), true)
  else await $.store.delete(key(s, 'userOff'))
}

async function stop($: EngineInterface, s: State, why: string | null) {
  if (s.deadline) await audit($, s, 'change', '停止保温', { why: why ?? '（无提示）', owner: s.owner, left: s.deadline - (await $.clock.now()) })
  s.deadline = 0
  s.owner = null
  s.reason = ''
  s.wakePrompt = ''
  s.sticky = false
  s.thenCompact = false
  s.stopped = why
  disarm(s)
  stopCaffeinate($, s)
  await save($, s)
  $.ui.status(statusText(s, await $.clock.now()))
  if (why) $.ui.toast(`keepwarm 停止：${why}`)
  await arm($, s)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  disarmCheck(s)
  const now = await $.clock.now()
  if (s.deadline && now >= s.deadline) {
    await audit($, s, 'change', '保温到期结束', { owner: s.owner })
    const compact = s.thenCompact && !s.compacted && !isCold(s, now)
    s.deadline = 0
    s.owner = null
    s.thenCompact = false
    await save($, s)
    if (compact) return autoCompact($, s, `空闲 ${fmtDuration(now - s.turnAt)} 没人回来，保温结束`)
  }
  const live = s.lastRequestAt > 0 && !s.compacted && !isCold(s, now)
  if (s.deadline) {
    if (live) {
      const delay = Math.min(s.deadline - now, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
      if (s.endWarnedFor !== s.deadline && s.deadline - now > 1000) {
        if (s.endWarn) s.endWarn.cancel()
        s.endWarn = $.clock.after(Math.max(1000, s.deadline - END_WARN_MS - now), () => { void endWarn($, s) })
      }
    } else {
      // Cold or just compacted: never ping (it would pay the rewrite); only expire the window.
      s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
    }
  } else if (live && s.policy !== 'off' && s.idle !== 'off' && s.ctx >= cfg.remindMinCtx && s.checkedFor !== s.turnAt) {
    // One reminder per idle stretch, before the cache lapses.
    s.check = $.clock.after(Math.max(1000, s.lastRequestAt + CHECK_AFTER_MS - now), () => { void idleCheck($, s) })
  }
  $.ui.status(statusText(s, now))
  await saveRuntime($, s)
}

// Module variables start over on a hot reload; the store does not.
async function saveRuntime($: EngineInterface, s: State) {
  if (!s.sid) return
  const rt: Runtime = { lastRequestAt: s.lastRequestAt, turnAt: s.turnAt, ctx: s.ctx, window: s.window, model: s.lastModel, compacted: s.compacted }
  await $.store.set(`rt:${s.sid}`, rt)
}

// The last read of this conversation's cache that keepwarm knows of: this session's own record,
// or the one a rewind or fork came from (another id, the same context within 1%). The engine
// dates a resumed cache from the transcript's last response and knows nothing of the pings and
// judges since (10-16: a rewound session was told 417K would be rewritten; it read all 417K).
async function lastKnownRead($: EngineInterface, s: State, ctx: number): Promise<number> {
  let at = 0
  for (const k of await $.store.keys()) {
    if (!k.startsWith('rt:')) continue
    const rt = (await $.store.get(k)) as Runtime | undefined
    if (!rt || rt.compacted) continue
    if ((k === `rt:${s.sid}` || Math.abs(rt.ctx - ctx) <= ctx * 0.01) && rt.lastRequestAt > at) at = rt.lastRequestAt
  }
  return at
}

async function loadRuntime($: EngineInterface, s: State, now: number) {
  for (const k of await $.store.keys()) {
    if (!k.startsWith('rt:') || k === `rt:${s.sid}`) continue
    const old = (await $.store.get(k)) as Runtime | undefined
    if (!old || now - old.lastRequestAt > RT_KEEP_MS) await $.store.delete(k)
  }
  const rt = (await $.store.get(`rt:${s.sid}`)) as Runtime | undefined
  if (!rt || s.lastRequestAt) return
  s.lastRequestAt = rt.lastRequestAt
  s.turnAt = rt.turnAt
  s.ctx = rt.ctx
  s.window = rt.window
  s.lastModel = rt.model
  s.compacted = rt.compacted
}

// ---------- leave: every live session at once ----------

// The sessions are separate processes; they talk through small JSON files, each
// written whole and renamed into place, so a reader never sees half a file.
const BUS = '$HOME/.claude/keepwarm-bus'

async function busGet<T>($: EngineInterface, name: string): Promise<T | undefined> {
  try {
    const r = await $.process.run(['sh', '-c', `cat "${BUS}/$1" 2>/dev/null`, 'kw', name])
    return r.stdout.trim() ? JSON.parse(r.stdout) as T : undefined
  } catch {
    return undefined
  }
}

async function busSet($: EngineInterface, s: State, name: string, value: unknown) {
  await auditedRun($, s, 'change', '写离开广播文件', ['sh', '-c', `mkdir -p "${BUS}" && printf '%s\\n' "$2" > "${BUS}/$1.$$" && mv "${BUS}/$1.$$" "${BUS}/$1"`, 'kw', name, JSON.stringify(value)], { file: name })
}

async function busAll<T>($: EngineInterface, prefix: string): Promise<T[]> {
  const r = await $.process.run(['sh', '-c', `cat "${BUS}/$1"* 2>/dev/null; true`, 'kw', prefix])
  const out: T[] = []
  for (const line of r.stdout.split('\n')) { try { if (line.trim()) out.push(JSON.parse(line) as T) } catch { /* partial */ } }
  return out
}

function leaveSkip(s: State, now: number): string | null {
  if (!s.lastRequestAt) return '还没有请求'
  if (s.compacted) return '刚 compact'
  if (isCold(s, now)) return '缓存已冷'
  if (s.ctx < MIN_CTX) return '上下文很小'
  return null
}

async function broadcastLeave($: EngineInterface, s: State, hours: number, machineOn: boolean, id?: string) {
  const now = await $.clock.now()
  const req: LeaveReq = { id: id ?? `${now}-${s.sid.slice(0, 8)}`, at: now, from: s.sid, hours, machineOn }
  const cur = await busGet<LeaveReq>($, 'leave-req')
  if (cur?.id === req.id) return
  await auditedRun($, s, 'change', '清理一天前的离开广播回复', ['sh', '-c', `find "${BUS}" -name 'leave-res-*' -mtime +1 -delete 2>/dev/null; true`])
  await busSet($, s, 'leave-req', req)
  await update($, leaveAll, () => ({ id: req.id, hours, machineOn, startedAt: now, items: [], collecting: true }))
  if (s.collect) s.collect.cancel()
  s.collect = $.clock.every(3000, () => { void collect($, s, req.id) })
  void poll($, s)
}

async function collect($: EngineInterface, s: State, id: string) {
  const la = await read($, leaveAll)
  if (!la || la.id !== id) { if (s.collect) s.collect.cancel(); s.collect = null; return }
  const items: KeepwarmLeaveItem[] = []
  for (const r of await busAll<{ id: string } & KeepwarmLeaveItem>($, 'leave-res-')) {
    if (r.id === id) items.push({ sid: r.sid, project: r.project, topic: r.topic ?? '', ctx: r.ctx, action: r.action, reason: r.reason, keepUsd: r.keepUsd, compactUsd: r.compactUsd, coldUsd: r.coldUsd })
  }
  const now = await $.clock.now()
  const done = now - la.startedAt >= LEAVE_COLLECT_MS
  await update($, leaveAll, v => v && v.id === id ? { ...v, items, collecting: !done } : v)
  if (done) {
    if (s.collect) s.collect.cancel()
    s.collect = null
    await pushLeaveSummary($, s, { ...la, items, collecting: false })
  }
}

async function poll($: EngineInterface, s: State) {
  const now = await $.clock.now()
  const req = await busGet<LeaveReq>($, 'leave-req')
  if (!req || req.id === s.leaveSeen || now - req.at >= LEAVE_REQ_TTL_MS) return
  s.leaveSeen = req.id
  if (leaveSkip(s, now) !== null) return
  const a = await leaveCheck($, s, req.hours, req.machineOn)
  const L = a.leave
  await busSet($, s, `leave-res-${s.sid}`, { id: req.id, sid: s.sid, project: project(s), topic: a.topic ?? '', ctx: a.ctx, action: a.action, reason: a.reason, keepUsd: L?.keepUsd ?? null, compactUsd: L?.compactUsd ?? null, coldUsd: a.coldUsd })
  // The advice waits in this session's own band; acting on it is done here, by hand.
  if (a.action !== 'ignore') {
    await offerAdvice($, s, a)
  }
}

// ---------- phone (ntfy): notifications, with buttons when a reply topic is set ----------

// reply_topic: where the buttons on a push post their one-time token; without it pushes carry none.
type Ntfy = { server: string; topic: string; reply: string | null }

async function ntfyConfig($: EngineInterface): Promise<Ntfy | null> {
  try {
    if (!cfg.ntfyConfigFile) return null
    const r = await $.process.run(['sh', '-c', 'f=$1; case $f in "~/"*) f="$HOME/${f#??}";; esac; cat "$f"', 'kw', cfg.ntfyConfigFile])
    const c = JSON.parse(r.stdout) as { server?: string; topic?: string; reply_topic?: string }
    return c.server && c.topic ? { server: c.server.replace(/\/$/, ''), topic: c.topic, reply: c.reply_topic || null } : null
  } catch {
    return null
  }
}

async function push($: EngineInterface, s: State, title: string, markdown: string, actions: NtfyAction[] = []) {
  const c = await ntfyConfig($)
  if (!c) return
  const body = { topic: c.topic, title, message: markdown.slice(0, 4000), markdown: true, priority: 3, tags: ['hourglass'], ...(actions.length ? { actions } : {}) }
  try {
    await auditedRun($, s, 'notify', '手机推送', ['curl', '-s', '-m', '15', '-H', 'Content-Type: application/json', '-d', JSON.stringify(body), c.server + '/'], { title })
  } catch {
    // offline: the desktop notification and band still show
  }
}

const ACTION_ZH = { compact: 'compact', keepwarm: '保温', ignore: '不管' } as const

async function pushLeaveSummary($: EngineInterface, s: State, la: KeepwarmLeaveAll) {
  if (!la.items.length) return
  const lines = la.items.map(i => `- **${i.project}**${i.topic ? `（${i.topic}）` : ''} ${fmtTok(i.ctx)} → **${ACTION_ZH[i.action]}**：${i.reason}`)
  await push($, s, `离开 ${fmtDuration(la.hours * 3_600_000)}：${la.items.length} 个会话`, lines.join('\n') + '\n\n建议已显示在各会话的输入框上方，到会话里自己处理。')
}

// Ten minutes before a keep-warm window ends: offer to extend it, once per window.
async function endWarn($: EngineInterface, s: State) {
  s.endWarn = null
  // A window the idle judge opened ends in a compaction by design: nothing to tell.
  if (s.thenCompact) return
  const now = await $.clock.now()
  if (!s.deadline || s.endWarnedFor === s.deadline || s.deadline - now > END_WARN_MS + 1000 || isCold(s, now)) return
  s.endWarnedFor = s.deadline
  const a: KeepwarmAdvice = {
    action: 'keepwarm', topic: '', reason: `保温约 ${fmtDuration(s.deadline - now)} 后结束，之后缓存会在 1 小时内过期。要续的话选保温`,
    hours: DEFAULT_WINDOW_MS / 3_600_000, ctx: s.ctx, coldUsd: coldUsd(s), hourUsd: hourUsd(s), judgeUsd: 0, at: now, auto: false,
  }
  await offerAdvice($, s, a)
  await alert($, s, '保温快结束了', `${a.reason}（上下文 ${fmtTok(s.ctx)}，过期重写 ${fmtUsd(coldUsd(s))}）`, [warmButton(a.hours, '续'), IGNORE_BUTTON])
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const now = await $.clock.now()
  // A window that ends while the last request's cache still holds needs no ping, only its end.
  // A judged compaction's window ends 55 minutes after the judge, and the judge's own fork
  // takes seconds, so the end can fall a little after this ping is due (10-15: one wasted ping).
  if (now >= s.deadline - 1000) return arm($, s)
  if (s.deadline <= s.lastRequestAt + PING_AFTER_MS + 60_000) {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
    return
  }
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s) // a turn re-armed meanwhile
  if (wakesItself(s, now)) {
    // Its own wakeup will refresh the cache; ping only if that wakeup does not come.
    s.pending = $.clock.after(s.wakeAt + WAKE_MARGIN_MS / 2 - now, () => { void ping($, s) })
    return
  }
  if (isCold(s, now)) return lapsedWindow($, s, s.deadline, '电脑睡眠或进程暂停超过 1 小时，ping 没能按时发出')
  if (await darkWake($)) {
    // Asleep but for a moment: try again; on the full wake the timer fires late and finds out.
    s.pending = $.clock.after(60_000, () => { void ping($, s) })
    return
  }
  if (s.last && now - s.last.at < PING_MIN_GAP_MS) {
    s.pending = $.clock.after(s.last.at + PING_MIN_GAP_MS - now, () => { void ping($, s) })
    return
  }
  const recent = (((await $.store.get('pings')) as Array<{ sid: string; at: number }> | undefined) ?? [])
    .filter(p => p.sid === s.sid && now - p.at < cfg.pingLimitHours * 3_600_000).length
  if (recent >= cfg.pingLimit) {
    const why = `${cfg.pingLimitHours} 小时内已 ping ${recent} 次，达到上限 ${cfg.pingLimit}`
    await alarm($, s, 'pinglimit', 'ping 次数到了上限', `${why}，保温已停。正常每 55 分钟一次，到上限多半是哪里出了问题，看 /keepwarm log。`)
    return stop($, s, why)
  }
  const reply = await auditedFork($, s, s.wakePrompt ? '保温 ping（带唤醒判断）' : '保温 ping', s.wakePrompt ? wakeJudgePrompt(s, now) : PING_PROMPT, s.owner === 'user')
  if (s.owner !== 'user') await checkBudget($, s)
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') return stop($, s, '没有可以 fork 的对话')
  if (!reply.isAnswered && reply.reason !== 'empty-reply') return stop($, s, `ping 失败（${reply.reason}）`)
  const u = reply.usage
  const usd = forkUsd(u, priceOf(s.lastModel))
  const warm = forkWasWarm(u)
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  s.pings += 1
  s.pingUsd += usd ?? 0
  await appendLog($, 'pings', { sid: s.sid, cwd: s.cwd, model: s.lastModel, ctx: s.ctx, owner: s.owner, ...s.last })
  if (warm && s.wakePrompt && reply.isAnswered) await wakeDecision($, s, reply.text, now)
  // Seen once (Taskline, 10-11): after a turn that died on a usage limit the fork no longer
  // replays what the main thread sent, so it misses a cache that may still be warm.
  const got = `ping 读 ${fmtTok(u.cache_read_input_tokens)}、写 ${fmtTok(u.cache_creation_input_tokens)}`
  if (!warm) return stop($, s, s.turnError ? `${got}：上一轮因 API 错误（如额度用完）中断后，ping 对不上主对话的缓存` : `${got}，缓存已经丢了`)
  s.lastRequestAt = now
  await arm($, s)
}

// With a wake task, the fork (which sees the whole conversation and the time) decides first,
// so a wake that needs nothing leaves the conversation untouched and only tool work becomes a turn.
function wakeJudgePrompt(s: State, now: number): string {
  return [
    '[keepwarm 定时唤醒，不是用户消息；不要调用工具，只输出一行 JSON]',
    `现在是 ${new Date(now).toString()}，用户已离开 ${fmtDuration(now - s.lastRequestAt)}，保温还剩 ${fmtDuration(s.deadline - now)}。`,
    `唤醒任务：${s.wakePrompt}`,
    '决定这次唤醒怎么处理：',
    '- skip：现在不需要做任何事（时间未到、无新情况），这次唤醒不留痕迹。',
    '- note：不需要工具，但有一句值得记入对话、供之后参考的话。',
    '- act：需要用工具真正检查或处理（看日志、查服务、跑命令），将运行一整轮对话并保留在对话里。',
    '- stop：任务已无必要，结束保温。',
    '输出格式：{"decision":"skip|note|act|stop","note":"<note 时的一句话，否则空>","task":"<act 时要做的具体事情，否则空>"}',
  ].join('\n')
}

async function wakeDecision($: EngineInterface, s: State, text: string, now: number) {
  let v: { decision?: string; note?: string; task?: string } = {}
  try {
    v = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? '{}')
  } catch {
    v = {}
  }
  const decision = v.decision === 'note' || v.decision === 'act' || v.decision === 'stop' ? v.decision : 'skip'
  await appendLog($, 'wakes', { sid: s.sid, cwd: s.cwd, at: now, decision, note: v.note ?? '', task: v.task ?? '' })
  if (decision === 'note' && v.note) {
    const text = `[keepwarm 唤醒记录 ${new Date(now).toLocaleString()}] ${String(v.note).slice(0, 500)}`
    try {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      await audit($, s, 'change', '往对话里插入唤醒记录', { text })
    } catch (err) {
      await audit($, s, 'change', '往对话里插入唤醒记录', { text, ok: false, error: errText(err) })
    }
    $.ui.toast(`keepwarm 记录：${String(v.note).slice(0, 80)}`)
  } else if (decision === 'act') {
    await auditedSubmit($, s, '唤醒后发起一轮真实对话',
      `[keepwarm 定时唤醒，保温剩 ${fmtDuration(s.deadline - now)}] ${v.task || s.wakePrompt}\n` +
        '做完后简短汇报；一切正常且无需用户处理就只回一行。保温会自动继续，任务已无必要时调用 keepwarm stop。')
  } else if (decision === 'stop') {
    await stop($, s, null)
  }
}

async function startWindow($: EngineInterface, s: State, windowMs: number, owner: Owner, reason: string, wakePrompt = '', sticky = false) {
  const now = await $.clock.now()
  const deadline = now + Math.min(windowMs, MAX_WINDOW_MS)
  // The model may extend the person's window, never shorten it.
  if (owner === 'model' && s.deadline && s.owner === 'user') {
    s.deadline = Math.max(s.deadline, deadline)
  } else {
    s.deadline = deadline
    s.owner = owner
    s.sticky = sticky
  }
  s.reason = reason
  s.wakePrompt = wakePrompt
  s.stopped = null
  await audit($, s, 'change', '开启保温', { by: owner, owner: s.owner, until: s.deadline, reason, wake: wakePrompt || undefined, sticky: s.sticky })
  await save($, s)
  await arm($, s)
}

// Keeps the Mac from idle sleep while a leave window runs; lid-close on battery still sleeps.
// The child dies with the module too (a reload), which only ends the stay-awake, not the window.
function caffeinate($: EngineInterface, s: State, ms: number) {
  stopCaffeinate($, s)
  const it = $.process.spawn({ argv: ['caffeinate', '-i', '-t', String(Math.ceil(ms / 1000))] })
  void audit($, s, 'change', '启动 caffeinate 防闲置睡眠', { seconds: Math.ceil(ms / 1000) })
  s.caff = it
  void (async () => {
    try { for await (const _ of it) { /* no output */ } } catch { /* not on macOS, or killed */ }
    if (s.caff === it) s.caff = null
  })()
}

function stopCaffeinate($: EngineInterface, s: State) {
  const it = s.caff
  s.caff = null
  if (it) {
    void it.return(undefined).catch(() => {})
    void audit($, s, 'change', '停止 caffeinate')
  }
}

// ---------- context reminder ----------

function judgePrompt(s: State, idleMs: number): string {
  return [
    '[keepwarm 自动检查，不是用户消息；不要调用工具，只输出一行 JSON]',
    `用户已离开约 ${fmtDuration(idleMs)}，prompt 缓存约 ${fmtDuration(TTL_MS - idleMs)} 后过期。`,
    `当前上下文 ${fmtTok(s.ctx)} tokens（窗口 ${fmtTok(s.window)}），项目目录 ${s.cwd}。`,
    `过期后用户回来时，重写缓存约 ${fmtUsd(coldUsd(s))}；保温约 ${fmtUsd(hourUsd(s))}/小时；compact 后约 15K tokens，但会丢失细节。`,
    ...(s.wakeAt > idleMs + s.lastRequestAt ? [`会话已经定好约 ${fmtDuration(s.wakeAt - s.lastRequestAt - idleMs)} 后自己醒来（ScheduleWakeup）。`] : []),
    '判断对这个会话最合适的做法：',
    '- keepwarm：任务还在进行或在等用户回复/审阅，细节仍然有用，用户很可能几小时内回来。',
    '- compact：一个阶段已经完成，之后只需要结论与要点，或上下文已接近上限。',
    '- ignore：对话已基本结束、用户短期内不会回来，或继续保留没有价值；或会话在缓存过期前自己会被唤醒（定好的唤醒、循环任务、快要回报的后台任务），它自己的请求就会续上缓存。',
    '输出格式：{"action":"compact|keepwarm|ignore","topic":"<这个会话在做什么、做到哪一步了，中文，100 字以内>","reason":"<为什么这样建议，中文，100 字以内>","hours":<若 keepwarm：建议保温小时数，1-12；否则 0>}',
  ].join('\n')
}

// What a compact costs now while warm, plus re-reading its result cold on return
// (system + tools + summary, roughly).
const COMPACT_OUT_TOK = 8000
const POST_COMPACT_TOK = 50000
const compactNowUsd = (s: State) => {
  const p = priceOf(s.lastModel)
  return p ? (s.ctx * p[0] + COMPACT_OUT_TOK * p[2] + POST_COMPACT_TOK * p[1]) / 1e6 : null
}

function leavePrompt(s: State, hours: number, machineOn: boolean, keepUsd: number | null, compactUsd: number | null): string {
  return [
    '[keepwarm 离开检查，不是用户消息；不要调用工具，只输出一行 JSON]',
    `用户现在要离开约 ${hours} 小时，${machineOn ? '电脑保持开机不睡眠，可以保温' : '电脑会合盖或关机，无法保温，缓存一定会过期'}。`,
    `当前上下文 ${fmtTok(s.ctx)} tokens（窗口 ${fmtTok(s.window)}），项目目录 ${s.cwd}，项目策略 ${s.policy}。`,
    '三个选项的估算花费：',
    machineOn ? `- keepwarm：保温 ${hours} 小时约 ${fmtUsd(keepUsd)}，回来时缓存是热的，细节全在。` : '- keepwarm：不可用。',
    `- compact：现在趁缓存还热压缩约 ${fmtUsd(compactUsd)}（含回来时冷读压缩结果），但会丢失细节。`,
    `- ignore：什么都不做，回来时重写缓存约 ${fmtUsd(coldUsd(s))}，细节全在。`,
    '综合花费和"回来后还需要哪些细节"判断。存放个人资料、长期记录、或正在进行且依赖大量细节的会话，不要建议 compact。',
    `输出格式：{"action":"${machineOn ? 'compact|keepwarm|ignore' : 'compact|ignore'}","topic":"<这个会话在做什么、做到哪一步了，中文，100 字以内>","reason":"<为什么这样建议，中文，100 字以内>","hours":${machineOn ? hours : 0}}`,
  ].join('\n')
}

async function leaveCheck($: EngineInterface, s: State, hours: number, machineOn: boolean): Promise<KeepwarmAdvice> {
  const now = await $.clock.now()
  s.checkedFor = s.turnAt // this idle stretch is handled; no 50-minute check on top
  disarmCheck(s)
  const keepUsd = machineOn ? (hourUsd(s) ?? 0) * hours || null : null
  const compactUsd = compactNowUsd(s)
  const reply = await auditedFork($, s, `离开判断（${hours}h，${machineOn ? '开机' : '关机'}）`, leavePrompt(s, hours, machineOn, keepUsd, compactUsd), true)
  let judgeUsd: number | null = null
  let v = null as ReturnType<typeof parseVerdict>
  if (reply.isAnswered) {
    judgeUsd = forkUsd(reply.usage, priceOf(s.lastModel))
    if (forkWasWarm(reply.usage)) s.lastRequestAt = now
    v = parseVerdict(reply.text)
  }
  if (!v) {
    // No usable answer: pick the cheapest option by the numbers alone.
    const opts: [KeepwarmAdvice['action'], number | null][] = [['keepwarm', keepUsd], ['compact', compactUsd], ['ignore', coldUsd(s)]]
    const best = opts.filter(o => o[1] != null).sort((a, b) => (a[1] as number) - (b[1] as number))[0]
    v = { action: best ? best[0] : 'ignore', topic: '', reason: '判断没有给出结果，按估算花费选了最便宜的', hours }
  }
  if (v.action === 'keepwarm' && !machineOn) v = { ...v, action: 'ignore' }
  const a: KeepwarmAdvice = {
    ...v, hours: Math.min(hours, MAX_WINDOW_MS / 3_600_000), ctx: s.ctx, coldUsd: coldUsd(s), hourUsd: hourUsd(s), judgeUsd, at: now, auto: false,
    leave: { hours, machineOn, keepUsd, compactUsd },
  }
  await appendLog($, 'judgements', { sid: s.sid, cwd: s.cwd, model: s.lastModel, ...a, read: reply.isAnswered ? reply.usage.cache_read_input_tokens : 0, write: reply.isAnswered ? reply.usage.cache_creation_input_tokens : 0 })
  await arm($, s)
  return a
}

function parseVerdict(text: string): { action: KeepwarmAdvice['action']; topic: string; reason: string; hours: number } | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const v = JSON.parse(m[0]) as Record<string, unknown>
    const action = v.action === 'compact' || v.action === 'keepwarm' || v.action === 'ignore' ? v.action : null
    if (!action) return null
    const hours = typeof v.hours === 'number' && v.hours > 0 ? Math.min(v.hours, 12) : 3
    return { action, topic: String(v.topic ?? '').slice(0, 400), reason: String(v.reason ?? '').slice(0, 400), hours }
  } catch {
    return null
  }
}

async function apply($: EngineInterface, s: State, a: KeepwarmAdvice, choice: KeepwarmAdvice['action'], by: 'user' | 'auto') {
  if (s.expire) s.expire.cancel()
  s.expire = null
  await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: await $.clock.now(), ctx: a.ctx, advised: a.action, reason: a.reason, chosen: choice, by })
  await update($, advice, () => null)
  if (choice === 'compact') {
    // A plain /compact: the compaction reads the whole conversation itself, so a list of what to
    // keep written by the judge only costs output tokens and narrows the summary.
    const command = '/compact'
    try {
      await auditedCompact($, s)
    } catch {
      // Headless hosts (the desktop app, the SDK) refuse a direct compaction and refuse a prompt
      // that starts with "/": run the /compact command itself. The clipboard stays as the last
      // resort, also when the command returned but no compaction followed.
      let failed = ''
      const n = s.compactions
      try {
        await auditedCommand($, s, 'compact（以 /compact 命令执行）', 'compact', '')
        if (s.compactions === n) failed = '命令已执行，但没有看到压缩发生'
      } catch (err) {
        failed = errText(err)
      }
      if (failed && by === 'auto') {
        // Nobody is at the session: leave the clipboard alone, say it only through an alert.
        await alarm($, s, 'compactfail', '自动 compact 没成功', `${failed}。会话还是原样，回来后可以手动 /compact。`)
      } else if (failed) {
        const copied = await $.ui.copy({ text: command }).catch(() => ({ isCopied: false }))
        await audit($, s, 'change', '复制 /compact 命令到剪贴板', { copied: copied.isCopied })
        $.ui.toast(`compact 没能自动执行（${failed}）。${copied.isCopied ? '命令已复制，' : ''}请在输入框发送：${command}`)
      }
    }
  } else if (choice === 'keepwarm') {
    await startWindow($, s, a.hours * 3_600_000, by === 'user' ? 'user' : 'model', a.reason || '空闲检查建议')
    if (a.leave?.machineOn) caffeinate($, s, s.deadline - (await $.clock.now()))
  }
}

// A reminder only means something while the cache it is about is still warm.
// The judge fork wrote or read the whole prefix at a.at, so that is when the hour starts.
const adviceStale = (a: KeepwarmAdvice, now: number) => now - a.at >= TTL_MS - 1000

// A new reminder goes to the band above the prompt until the cache it is about lapses.
async function offerAdvice($: EngineInterface, s: State, a: KeepwarmAdvice) {
  await update($, advice, () => a)
  await expireAdvice($, s)
}

async function expireAdvice($: EngineInterface, s: State) {
  if (s.expire) s.expire.cancel()
  s.expire = null
  const a = await read($, advice)
  if (!a) return
  const now = await $.clock.now()
  if (!adviceStale(a, now)) {
    s.expire = $.clock.after(a.at + TTL_MS - now, () => { void expireAdvice($, s) })
    return
  }
  await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: a.ctx, advised: a.action, reason: a.reason, chosen: 'expired', by: 'auto' })
  await update($, advice, () => null)
}

// The session's own scheduled wakeup fires while the cache is still warm, with time to spare.
const wakesItself = (s: State, now: number) => s.wakeAt > now && s.wakeAt < s.lastRequestAt + TTL_MS - WAKE_MARGIN_MS

// Compact with nobody asked and nobody told: the audit log records it.
async function autoCompact($: EngineInterface, s: State, reason: string) {
  const now = await $.clock.now()
  await apply($, s, { action: 'compact', reason, topic: '', hours: 0, ctx: s.ctx, coldUsd: coldUsd(s), hourUsd: hourUsd(s), judgeUsd: null, at: now, auto: true }, 'compact', 'auto')
}

async function idleCheck($: EngineInterface, s: State, forced = false) {
  s.check = null
  const now = await $.clock.now()
  if (!forced && (s.deadline || isCold(s, now) || s.compacted || now - s.lastRequestAt < CHECK_AFTER_MS - 1000)) return arm($, s)
  if (!forced && (await darkWake($))) {
    s.check = $.clock.after(60_000, () => { void idleCheck($, s) })
    return
  }
  s.checkedFor = s.turnAt
  if (!forced && wakesItself(s, now)) {
    await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: s.ctx, advised: 'ignore', reason: `会话定好了 ${fmtDuration(s.wakeAt - now)} 后自己醒来`, chosen: 'self-wake', by: 'auto' })
    return arm($, s)
  }
  if (!forced && cfg.skipGroups.length) {
    const group = await sidebarGroup($, s)
    if (group && cfg.skipGroups.includes(group.toLowerCase())) {
      await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: s.ctx, advised: 'ignore', reason: `侧边栏分组「${group}」不做空闲检查`, chosen: 'skip-group', by: 'auto' })
      return arm($, s)
    }
  }
  if (!forced && cfg.skipScratch && SCRATCH.test(await $.session.cwd())) {
    await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: s.ctx, advised: 'ignore', reason: '没有项目的聊天会话（app 自建的临时文件夹）不做空闲检查', chosen: 'skip-scratch', by: 'auto' })
    return arm($, s)
  }
  if (s.policy === 'warm') {
    await startWindow($, s, DEFAULT_WINDOW_MS, 'user', '项目策略：总是保温')
    return
  }
  if (!forced && s.idle === 'judge' && (await overBudget($))) {
    // Over the day's budget: no judge, and nothing to bother the person with.
    await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: s.ctx, advised: 'ignore', reason: '今天的自动预算已用完', chosen: 'budget', by: 'auto' })
    return arm($, s)
  }
  if (!forced && s.bg.length && !(await overBudget($))) {
    // Waiting on background work it started, which wakes it when it reports: keep warm until then
    // with no judge (the session itself comes back, not only the person).
    const what = s.bg.slice(0, 3).join('；')
    await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: s.ctx, advised: 'keepwarm', reason: `后台任务在跑：${what}`, chosen: 'background', by: 'auto' })
    s.thenCompact = true
    await startWindow($, s, s.turnAt + BG_KEEP_MS - now, 'model', `等 ${s.bg.length} 个后台任务回报（${what}），最长到空闲 ${fmtDuration(BG_KEEP_MS)}，之后 compact`)
    return
  }
  if (s.idle === 'notify' && !forced) {
    // No model call: just say the cache is about to lapse and what that costs.
    const left = fmtDuration(TTL_MS - (now - s.lastRequestAt))
    const msg = `缓存约 ${left} 后过期。上下文 ${fmtTok(s.ctx)}，过期后重写约 ${fmtUsd(coldUsd(s))}，保温约 ${fmtUsd(hourUsd(s))}/h`
    await alert($, s, '缓存快过期', msg, [warmButton(3), warmButton(8), COMPACT_BUTTON])
    return arm($, s)
  }
  const reply = await auditedFork($, s, forced ? '空闲判断（手动 check）' : '空闲判断（50 分钟）', judgePrompt(s, now - s.lastRequestAt), forced)
  if (!forced) await checkBudget($, s)
  if (!reply.isAnswered) {
    if (reply.reason !== 'nothing-to-fork') $.ui.log(`keepwarm 空闲检查没有得到回答（${reply.reason}）`)
    return arm($, s)
  }
  const u = reply.usage
  const judgeUsd = forkUsd(u, priceOf(s.lastModel))
  // The fork read the whole prefix, so the cache is good for another hour.
  if (forkWasWarm(u)) s.lastRequestAt = now
  const v = parseVerdict(reply.text) ?? { action: 'keepwarm' as const, topic: '', reason: '判断结果无法解析，默认建议保温', hours: 3 }
  const a: KeepwarmAdvice = { ...v, ctx: s.ctx, coldUsd: coldUsd(s), hourUsd: hourUsd(s), judgeUsd, at: now, auto: s.policy === 'auto' }
  await appendLog($, 'judgements', { sid: s.sid, cwd: s.cwd, model: s.lastModel, ...a, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens })
  if (forced) {
    // /keepwarm check: the person asked, so show the advice and let them choose.
    if (a.action !== 'ignore') await offerAdvice($, s, a)
  } else if (a.action === 'compact') {
    // Nobody is asked or told (10-14): compact. Not now, though: the judge just read the whole
    // cache, so it holds another hour; compacting near its end costs the same and leaves that
    // hour for the person to come back to the full context.
    await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: a.ctx, advised: a.action, reason: a.reason, chosen: 'compact-later', by: 'auto' })
    s.thenCompact = true
    await startWindow($, s, s.lastRequestAt + PING_AFTER_MS - (await $.clock.now()), 'model', '空闲判断：compact，等这次判断续上的一小时快用完时再压')
    return
  } else if (a.action === 'keepwarm') {
    // Kept warm at night too (10-15): an idle Mac at 1 a.m. is no sign of bed (the person often
    // sleeps at 4 and is back about five hours later), and compacting then costs more than the
    // pings it spares whenever they return inside the window.
    await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: a.ctx, advised: 'keepwarm', reason: a.reason, chosen: 'keepwarm', by: 'auto' })
    s.thenCompact = true
    await startWindow($, s, s.turnAt + KEEP_UNTIL_MS - now, 'model', `空闲判断：保温到空闲 ${fmtDuration(KEEP_UNTIL_MS)}，之后 compact`)
    return
  } else {
    await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: now, ctx: a.ctx, advised: 'ignore', reason: a.reason, chosen: 'ignore', by: 'auto' })
  }
  await arm($, s)
}

function hoursOf(v: unknown): number {
  const h = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_WINDOW_MS / 3_600_000
  return Math.min(Math.max(h, 0.25), MAX_WINDOW_MS / 3_600_000)
}

export const register: Register = (on, options) => {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  cfg.ntfyConfigFile = typeof options.ntfyConfigFile === 'string' ? options.ntfyConfigFile.trim() : ''
  cfg.remindMinCtx = num(options.remindMinContext, cfg.remindMinCtx)
  cfg.awayIdleS = num(options.awayMinutes, cfg.awayIdleS / 60) * 60
  cfg.pingLimit = num(options.pingLimit, cfg.pingLimit)
  cfg.pingLimitHours = num(options.pingLimitHours, cfg.pingLimitHours) || cfg.pingLimitHours
  cfg.dailyBudgetUsd = num(options.dailyBudgetUsd, cfg.dailyBudgetUsd)
  if (typeof options.skipScratch === 'boolean') cfg.skipScratch = options.skipScratch
  if (typeof options.skipGroups === 'string') cfg.skipGroups = options.skipGroups.split(',').map(g => g.trim().toLowerCase()).filter(Boolean)
  const idle = options.idleCheck
  cfg.idleDefault = idle === 'off' || idle === 'judge' ? idle : 'notify'
  const s: State = {
    sid: '', cwd: '', policy: 'ask', guard: 'warn', ackedAt: 0, stepCtx: 0, stepModel: null, skipMiss: false, turnBy: 'person', misses: [], deadline: 0, every: PING_AFTER_MS, owner: null, reason: '', wakePrompt: '', userOff: false, sticky: false,
    lastRequestAt: 0, lastModel: null, ctx: 0, window: 0, compacted: false, compactions: 0, turnError: false, pending: null, check: null, expire: null, endWarn: null, endWarnedFor: 0, tick: null, caff: null, checkedFor: -1, turnAt: 0, poll: null, collect: null, leaveSeen: '', idle: cfg.idleDefault, thenCompact: false, wakeAt: 0, wakeBySleep: false, bg: [],
    last: null, pings: 0, pingUsd: 0, stopped: null, paneTick: null, phonePoll: null, phoneBusy: false,
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.sid = await $.session.id()
    s.cwd = await $.session.cwd()
    const now = await $.clock.now()
    const saved = await $.store.get(key(s, 'deadline'))
    if (typeof saved === 'number' && saved > now) {
      s.deadline = saved
      s.owner = ((await $.store.get(key(s, 'owner'))) as Owner | undefined) ?? 'user'
      s.reason = ((await $.store.get(key(s, 'reason'))) as string | undefined) ?? ''
      s.wakePrompt = ((await $.store.get(key(s, 'wake'))) as string | undefined) ?? ''
      s.sticky = (await $.store.get(key(s, 'sticky'))) === true
      s.thenCompact = (await $.store.get(key(s, 'thenCompact'))) === true
    } else if (saved !== undefined) {
      for (const k of ['deadline', 'owner', 'reason', 'wake', 'sticky', 'thenCompact']) await $.store.delete(key(s, k))
    }
    s.userOff = (await $.store.get(key(s, 'userOff'))) === true
    const bg = await $.store.get(key(s, 'bg'))
    s.bg = Array.isArray(bg) ? bg.filter((x): x is string => typeof x === 'string') : []
    await expireAdvice($, s) // a reminder left over from before a reload or restart
    if ((await phoneTokens($, s)).some(t => t.exp > now)) armPhonePoll($, s) // buttons on a push still out
    await loadRuntime($, s, now)
    // The desktop app starts a session's process only when the session is opened, so after an
    // app restart (an update installs itself while the Mac is idle) no ping went out meanwhile.
    if (typeof saved === 'number' && s.lastRequestAt && saved > s.lastRequestAt + TTL_MS && isCold(s, now)) {
      await lapsedWindow($, s, saved, '这个会话的进程中途没在运行（app 重启或退出后，会话要打开才会重新启动）')
    }
    const seen = await busGet<LeaveReq>($, 'leave-req')
    if (seen) s.leaveSeen = seen.id // a request from before this process is not for it
    if (s.tick) s.tick.cancel()
    s.tick = $.clock.every(60_000, () => {
      void (async () => {
        const now = await $.clock.now()
        $.ui.status(statusText(s, now))
      })()
    })
    if (s.poll) s.poll.cancel()
    s.poll = $.clock.every(POLL_MS, () => { void poll($, s) })
    const idle = await $.store.get('idle')
    s.idle = idle === 'off' || idle === 'notify' || idle === 'judge' ? idle : cfg.idleDefault
    const policy = await $.store.get(`policy:${s.cwd}`)
    s.policy = policy === 'auto' || policy === 'warm' || policy === 'off' ? policy : 'ask'
    const guard = await $.store.get('guard')
    s.guard = guard === 'refuse' || guard === 'off' ? guard : 'warn' // never block unless asked to
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    s.window = usage.context.window
    s.lastModel = await $.session.model()
    await $.command.register({
      name: 'keepwarm',
      description: '缓存保温与空闲提醒：on 8h | off | check | panel | alert on/off | status | help（全部用法）',
      argumentHint: '[on 8h | off | check | panel | alert on|off | status | help]',
      immediate: true,
    })
    await $.tool.register({
      name: 'keepwarm',
      description:
        "Keeps this session's 1-hour prompt cache warm while the user is away: 55 minutes after the last request it sends a tool-less fork " +
        'of this conversation that is billed at the cache-read rate and adds nothing to the transcript, instead of the user ' +
        'paying a full cache re-write when they come back (e.g. 400K tokens on Opus 5.5: ~$0.10/h warm vs ~$3.20 cold). ' +
        'Call action "start" when you end a turn with a large context (100K+ tokens) and the user will plausibly return to ' +
        'THIS conversation within the next hours: work is mid-way, you are waiting on their review or answer, or they said ' +
        'they will be back. Pick hours to cover that gap (default 3, max 12). Call "stop" when the work is finished, the user ' +
        'is done for the day, or you are about to suggest /clear or a new session. A running window re-arms itself after every ' +
        'turn, so do not call start again each turn; call "status" if unsure. The user\'s /keepwarm command overrides you: if ' +
        'they turned it off, start is refused. Without a window keepwarm already acts on its own: while background work you ' +
        'started (a shell, a subagent, a monitor) runs, it keeps the cache warm until that work reports; otherwise an idle ' +
        'check at 50 minutes keeps it warm or compacts. So never wake yourself (sleep, ScheduleWakeup) just to keep the cache ' +
        'warm; start a window only for a wait no background task covers, such as a job on a remote server with no local watcher. ' +
        'If something should be checked while the user is away (a training job, a deploy, a service), pass wake_prompt: at each ' +
        'wake the fork first decides, knowing the time, to skip silently, record a one-line note in this conversation, run a ' +
        'real turn with tools (only then does the conversation grow), or stop.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status'] },
          hours: { type: 'number', description: 'Window length for start, 0.25 to 12. Default 3.' },
          reason: { type: 'string', description: 'One short phrase on why the user is expected back (shown to the user).' },
          wake_prompt: { type: 'string', description: 'Optional. What to look at on each wake, e.g. "after 14:00 check the training log for errors". Omit for a pure keep-warm.' },
        },
        required: ['action'],
      },
    })
    await arm($, s)
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      s.deadline = 0
      s.owner = null
      s.stopped = null
      s.ctx = 0
      s.lastRequestAt = 0
      s.turnAt = 0
      s.compacted = false
      s.ackedAt = 0
      s.stepCtx = 0
      s.skipMiss = false
      s.misses = []
      s.sid = await $.session.id()
      await update($, advice, () => null)
      await arm($, s)
      return r
    }
    if (e.source === 'resume' || e.source === 'fork') {
      if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
      const now = await $.clock.now()
      if (typeof e.seconds_since_last_response === 'number') {
        s.turnAt = now - e.seconds_since_last_response * 1000
        s.lastRequestAt = Math.max(s.turnAt, await lastKnownRead($, s, s.ctx))
      }
      if (typeof e.model === 'string') s.lastModel = e.model
      s.compacted = false
      if (e.prompt_cache_likely_expired === true && isCold(s, now) && s.ctx >= GUARD_MIN_CTX && s.guard !== 'off') {
        const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
        $.ui.log(`keepwarm：恢复的会话缓存已冷，第一条消息会重写 ${fmtTok(s.ctx)} tokens，约 ${usd}。只需要结论的话，可以先 /compact 或 /clear 后贴摘要。`)
      }
      await arm($, s)
    }
    return r
  })

  // The session scheduling its own wakeup (ScheduleWakeup, as /loop does): remember when it fires.
  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || 'deny' in r || r.isError) return r
    const input = e as unknown as { delaySeconds?: unknown; stop?: unknown }
    const now = await $.clock.now()
    const delay = typeof input.delaySeconds === 'number' ? Math.min(Math.max(input.delaySeconds, 60), 3600) : 0
    s.wakeAt = input.stop === true || !delay ? 0 : now + delay * 1000
    s.wakeBySleep = false
    await audit($, s, 'change', '记下会话自己定的唤醒', { wakeAt: s.wakeAt ? new Date(s.wakeAt).toISOString() : null })
    return r
  })

  // The same with a background shell that sleeps first (`sleep 3300`, seen in long research
  // sessions, 10-11): it ends, and so wakes the session, when the sleep is over.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || 'deny' in r || r.isError) return r
    const input = e as unknown as { command?: unknown; run_in_background?: unknown }
    const m = input.run_in_background === true && typeof input.command === 'string' ? SELF_WAKE.exec(input.command) : null
    if (m) {
      s.wakeAt = (await $.clock.now()) + Number(m[1]) * 1000
      s.wakeBySleep = true
      await audit($, s, 'change', '记下会话自己定的唤醒（后台 sleep）', { wakeAt: new Date(s.wakeAt).toISOString() })
    }
    return r
  })

  // When the main thread stops, the engine lists the background work still running (shells,
  // subagents, monitors): each wakes the session when it reports.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id) return r
    const tasks = e.background_tasks ?? []
    s.bg = tasks.filter(t => !WATCH.test(t.description ?? '')).map(t => (t.description || t.command || t.type).slice(0, 80))
    // A sleeping shell no longer listed was stopped: its wakeup will not come.
    if (s.wakeBySleep && e.background_tasks && !tasks.some(t => SELF_WAKE.test(t.command ?? ''))) {
      s.wakeAt = 0
      s.wakeBySleep = false
    }
    if (s.bg.length) await $.store.set(key(s, 'bg'), s.bg)
    else await $.store.delete(key(s, 'bg'))
    return r
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { action?: string; hours?: unknown; reason?: unknown; wake_prompt?: unknown }
    const now = await $.clock.now()
    const reason = typeof input.reason === 'string' ? input.reason.slice(0, 120) : ''
    if (input.action === 'status') return { result: await card($, s, now) }
    if (input.action === 'stop') {
      if (s.owner === 'user' && s.deadline) return { result: `The user started this window themselves (${fmtDuration(s.deadline - now)} left); leave it, or tell them they can /keepwarm off.` }
      if (!s.deadline) return { result: 'keepwarm was already off.' }
      await stop($, s, null)
      return { result: 'keepwarm stopped.' }
    }
    if (input.action !== 'start') return { result: 'action must be start, stop or status.' }
    if (s.userOff) return { result: 'Refused: the user turned keepwarm off for this session with /keepwarm off. Mention it if a long break is coming; only they can re-enable it.' }
    if (s.ctx < MIN_CTX) return { result: `Not started: the context is only ${fmtTok(s.ctx)} tokens, so a cold re-write costs about ${fmtUsd(coldUsd(s))}; keeping it warm is not worth it.` }
    const wake = typeof input.wake_prompt === 'string' ? input.wake_prompt.trim().slice(0, 500) : ''
    await startWindow($, s, hoursOf(input.hours) * 3_600_000, 'model', reason, wake)
    const cold = isCold(s, now) ? ' The cache is cold right now, so pings begin 55 minutes after the next turn.' : ''
    return { result: `keepwarm on for ${fmtDuration(s.deadline - now)} (owner: ${s.owner})${wake ? ', with a wake task' : ''}. About ${fmtUsd(hourUsd(s))}/h vs ${fmtUsd(coldUsd(s))} for one cold re-write.${cold}` }
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    const cmd = words[0] ?? 'status'
    if (cmd === 'help') return { text: HELP }
    if (cmd === 'push') {
      const c = await ntfyConfig($)
      if (!c) return { text: '没有配置手机推送（ntfyConfigFile）' }
      if (!c.reply) return { text: '推送配置里没有 reply_topic，手机通知不会带按钮' }
      const actions = await phoneActions($, s, [warmButton(1), IGNORE_BUTTON, COMPACT_BUTTON], c)
      await push($, s, `${await sessionName($, s)} · 测试按钮`, '测试推送：点「保温 1h」，约半分钟内这个会话开始保温，并再推一条确认；「compact」会真的压缩这个会话。', actions)
      return { text: '测试推送已发到手机。点按钮后约半分钟内这个会话照做，并再推一条确认（Mac 不用醒着看，但要开着、这个会话的进程要在）。' }
    }
    if (cmd === 'panel') {
      const r = await openPanel($, s)
      return { text: r.isPlaced ? '按钮面板已打开' : `面板已打开但还没显示（${r.reason}）` }
    }
    if (cmd === 'off') {
      s.userOff = true
      await audit($, s, 'change', '改设置', { key: 'userOff', value: true })
      await stop($, s, null)
      return { text: 'keepwarm 已关，本会话内模型也不能再开启（/keepwarm auto 恢复）' }
    }
    if (cmd === 'auto') {
      s.userOff = false
      await audit($, s, 'change', '改设置', { key: 'userOff', value: false })
      await save($, s)
      return { text: '已允许模型自行开关保温' }
    }
    if (cmd === 'check') {
      void idleCheck($, s, true)
      return { text: '正在做一次空闲检查（fork 判断），结果会显示在输入框上方' }
    }
    if (cmd === 'leave') {
      let hours = 2
      let machineOn = true
      for (const w of words.slice(1)) {
        if (w === 'on') machineOn = true
        else if (w === 'off') machineOn = false
        else {
          const ms = parseDuration(w)
          if (ms == null) return { text: '用法：/keepwarm leave [2h] [on|off]（on：电脑开着；off：合盖或关机）' }
          hours = ms / 3_600_000
        }
      }
      await broadcastLeave($, s, hours, machineOn)
      const mine = leaveSkip(s, now)
      return { text: `已通知所有开着的会话：离开 ${fmtDuration(hours * 3_600_000)}（${machineOn ? '电脑开着' : '合盖/关机'}）。缓存还热的会话各自判断一次，约 ${LEAVE_COLLECT_MS / 1000} 秒内汇总到输入框上方并推送到手机` + (mine ? `（本会话${mine}，不参与）` : '') }
    }
    if (cmd === 'log') {
      // The audit trail: every request keepwarm paid for and every change it made.
      type A = { at: number; sid?: string; kind: string; what: string; usd?: number; read?: number; write?: number; in?: number; out?: number; ok?: boolean; error?: string; answered?: boolean; reason?: string }
      const scopeAll = words.includes('all')
      const only = words.includes('requests') ? 'request' : words.includes('changes') ? 'change' : null
      const rows = (((await $.store.get('audit')) as A[] | undefined) ?? [])
        .filter(r => (scopeAll || r.sid === s.sid) && (!only || r.kind === only))
      const spent = rows.reduce((a, r) => a + (r.kind === 'request' ? r.usd ?? 0 : 0), 0)
      const nReq = rows.filter(r => r.kind === 'request').length
      const fmt = (r: A) => {
        const when = new Date(r.at).toLocaleString('zh-CN', { hour12: false })
        const tag = { request: '请求', change: '改动', notify: '通知' }[r.kind] ?? r.kind
        const cost = r.kind === 'request' ? `  读 ${fmtTok(r.read ?? 0)} 写 ${fmtTok(r.write ?? 0)} 入 ${fmtTok(r.in ?? 0)} 出 ${fmtTok(r.out ?? 0)}  ${fmtUsd(r.usd ?? 0)}` : ''
        const bad = r.error ? `  失败：${r.error}` : r.ok === false ? '  失败' : r.answered === false ? `  未回答（${r.reason ?? ''}）` : ''
        return `${when}  [${tag}] ${r.what}${cost}${bad}`
      }
      return { text: [
        `keepwarm 审计记录（${scopeAll ? '所有会话' : '本会话'}${only ? '，只看' + (only === 'request' ? '请求' : '改动') : ''}）：共 ${rows.length} 条，其中请求 ${nReq} 次、合计 ${fmtUsd(spent)}；最近 30 条：`,
        ...rows.slice(-30).map(fmt),
        '/keepwarm log [all] [requests|changes]',
      ].join('\n') }
    }
    if (cmd === 'idle') {
      const v = words[1]
      if (v !== 'off' && v !== 'notify' && v !== 'judge') return { text: `空闲检查：${s.idle}。用法：/keepwarm idle off|notify|judge（所有会话）` }
      s.idle = v
      await $.store.set('idle', v)
      await audit($, s, 'change', '改设置', { key: 'idle', value: v })
      await arm($, s)
      return { text: { off: '空闲检查已关：50 分钟时什么都不做', notify: '空闲检查改为只提醒：50 分钟时免费通知一下缓存快过期，不调用模型', judge: '空闲检查改为判断：50 分钟时 fork 一次（约 $0.03）给出 compact/保温/不管 建议' }[v] }
    }
    if (cmd === 'alert') {
      const v = words[1]
      if (v === 'test') {
        await alert($, s, '⚠️ 测试报警', '这是一条测试报警：能看到它，说明 Mac 通知可用；离开电脑时同样的报警会推到手机。')
        return { text: '已发出一条测试报警（Mac 通知；你离开电脑超过设定时间时才推到手机）' }
      }
      if (v !== 'on' && v !== 'off') return { text: `${await alertLine($, now)}\n用法：/keepwarm alert on|off|test（所有会话）` }
      await $.store.set('alert', v === 'on')
      await audit($, s, 'change', '改设置', { key: 'alert', value: v === 'on' })
      return { text: v === 'on'
        ? '报警已开（所有会话）：保温失效、缓存被意外整段重写、ping 次数到上限、自动花费超过上限时，发 Mac 通知（你离开电脑时也推到手机）；同一类每个会话一小时最多一次。普通的过期（你隔几小时才回来）不报。'
        : '报警已关' }
    }
    if (cmd === 'guard') {
      const g = words[1]
      if (g !== 'refuse' && g !== 'warn' && g !== 'off') return { text: '用法：/keepwarm guard refuse|warn|off' }
      s.guard = g
      await $.store.set('guard', g)
      await audit($, s, 'change', '改设置', { key: 'guard', value: g })
      return { text: { refuse: '冷发送会先被拦一次并显示价格，再发一次即通过', warn: '冷发送照常发出，只显示价格', off: '不再检查冷发送' }[g] }
    }
    if (cmd === 'ledger') {
      const all = await missesTotal($)
      const mine = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
      return { text: `冷写入：本会话 ${s.misses.length} 次 ${fmtUsd(mine)}；所有会话累计 ${all.n} 次 ${fmtUsd(all.usd)}（最近 ${LOG_MAX} 条）` }
    }
    if (cmd === 'policy') {
      const p = words[1]
      if (p !== 'ask' && p !== 'auto' && p !== 'warm' && p !== 'off') return { text: '用法：/keepwarm policy ask|auto|warm|off（作用于当前项目目录）' }
      s.policy = p
      await $.store.set(`policy:${s.cwd}`, p)
      await audit($, s, 'change', '改设置', { key: `policy:${s.cwd}`, value: p })
      await arm($, s)
      const what = { ask: '空闲 50 分钟时判断并自动执行（同 auto）', auto: '空闲 50 分钟时判断并自动执行', warm: '空闲 50 分钟时直接保温 3 小时，不做判断', off: '不做空闲检查' }[p]
      return { text: `${project(s)} 的策略设为 ${p}：${what}` }
    }
    if (cmd === 'on' || parseDuration(cmd) != null) {
      const ms = parseDuration(cmd === 'on' ? (words[1] ?? '3h') : cmd)
      if (ms == null) return { text: '用法：/keepwarm on 3h | 90m' }
      let every = PING_AFTER_MS
      // "every 2m" is a testing knob for this window only.
      const ei = words.indexOf('every')
      if (ei >= 0) {
        const period = parseDuration(words[ei + 1] ?? '')
        if (period == null || period < MIN_PING_MS) return { text: 'every 至少 1m' }
        every = period
      }
      s.every = every
      s.userOff = false
      await startWindow($, s, ms, 'user', '手动开启', '', true)
      return { text: `保温开启 ${fmtDuration(s.deadline - now)}：这段时间里缓存不会过期，不管会话在干活、等后台任务还是等你；你发消息也不会取消，/keepwarm off 关。闲着时约 ${fmtUsd(hourUsd(s))}/小时（过期重写一次约 ${fmtUsd(coldUsd(s))}）` }
    }
    return { text: await card($, s, now) }
  })

  on('prompt.submit', async ($, e, next) => {
    // A turn something else started (a background task done, a schedule, another session) is not
    // the person coming back: it neither answers a reminder nor ends their absence's window.
    // Seen 10-14: a subagent's notice ended a window the person was away for.
    const person = !NOT_THE_PERSON.has(e.origin.kind)
    s.turnBy = person ? 'person' : e.origin.kind
    // The person is back: an unanswered reminder is moot.
    if (person && (await read($, advice))) {
      const a = await read($, advice)
      if (a) await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: await $.clock.now(), ctx: a.ctx, advised: a.action, reason: a.reason, chosen: 'returned', by: 'user' })
      await update($, advice, () => null)
    }
    // The person is back: the absence a reminder's or the model's window covered is over. A
    // window opened with /keepwarm on runs its hours whatever they do (while they work their own
    // requests keep the cache warm and no ping goes out); only /keepwarm off ends it.
    if (person && s.deadline && !s.sticky && typeof e.text === 'string' && !e.text.trimStart().startsWith('/')) {
      await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: await $.clock.now(), ctx: s.ctx, advised: 'keepwarm', reason: s.reason, chosen: 'returned-stop', by: 'user' })
      await stop($, s, null)
      s.stopped = null
    }
    // A window the idle check opened covers one quiet stretch: any turn ends it (a background task
    // reporting, a wakeup), and that turn's end looks at the session afresh. No compaction: the
    // turn has just used the context.
    if (!person && s.deadline && s.thenCompact && typeof e.text === 'string' && !e.text.trimStart().startsWith('/')) {
      await appendLog($, 'decisions', { sid: s.sid, cwd: s.cwd, at: await $.clock.now(), ctx: s.ctx, advised: 'keepwarm', reason: s.reason, chosen: 'woken-stop', by: 'auto' })
      await stop($, s, null)
      s.stopped = null
    }
    if (e.origin.kind === 'plugin' || typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    if (s.guard === 'off' || !isCold(s, now) || s.ctx < GUARD_MIN_CTX) return next(e)
    if (s.guard === 'warn') return next(e)
    // Refuse once per cold stretch; the resend goes through.
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    await audit($, s, 'change', '拦下冷发送（guard refuse）', { ctx: s.ctx, coldUsd: coldUsd(s) })
    return { drop: `keepwarm：${guardText(s, now)}再发一次即照付；或先 /compact、/clear 后贴摘要。（/keepwarm guard warn 改为只提示）` }
  })

  on('turn.step', async function* ($, e, next) {
    // Every model request of the main loop (a prompt or a tool result going back) reads and
    // refreshes the cache: restart the hour and redraw the footer now, not at turn end.
    const before = s.lastRequestAt
    if (!e.agentId) {
      const now = await $.clock.now()
      s.turnAt = s.lastRequestAt = now
      // The first request after a compaction writes the cache afresh: the hour runs again.
      s.compacted = false
      $.ui.status(statusText(s, now))
    }
    const res = yield* next(e)
    // Bookkeeping only: whatever goes wrong here must not touch the request.
    if (!e.agentId && res?.usage) await checkMiss($, s, res.usage, before).catch(err => $.ui.log(`keepwarm：冷写入记录失败 ${errText(err)}`, { to: 'debug' }))
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.turnAt = s.lastRequestAt
    s.compacted = false
    s.turnError = e.reason === 'error'
    if (e.usage?.model) s.lastModel = e.usage.model
    const usage = await $.session.usage()
    if (usage.context.tokens && usage.context.tokens > 0) s.ctx = usage.context.tokens
    s.ackedAt = 0
    s.window = usage.context.window
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.compactions++
      s.skipMiss = true
      s.stepCtx = 0
      disarm(s)
      disarmCheck(s)
    }
    return r
  })

  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) {
      if (s.paneTick) s.paneTick.cancel()
      s.paneTick = null
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, panel)
    const now = await $.clock.now()
    const stored = await read($, advice)
    const a = stored && !adviceStale(stored, now) ? stored : null
    const { Box, Button, Text } = $.ui.resolve(e)
    const warm = s.lastRequestAt > 0 && !s.compacted && !isCold(s, now)
    const cache = !s.lastRequestAt ? '本会话还没有请求'
      : s.compacted ? '刚 compact，下一轮会从摘要开始'
      : isCold(s, now) ? `缓存已过期 ${fmtDuration(now - s.lastRequestAt - TTL_MS)}`
      : `缓存还剩 ${fmtDuration(s.lastRequestAt + TTL_MS - now)}`
    const win = s.deadline
      ? `保温中，还剩 ${fmtDuration(s.deadline - now)}（${s.sticky ? '发消息不会结束' : '你回来发消息就结束'}）`
      : s.stopped ? `保温已停：${s.stopped}` : '没在保温'
    const head = a ? { compact: '建议 compact', keepwarm: `建议保温 ${a.hours}h`, ignore: '建议不管' }[a.action] : null
    return (
      <Box flexDirection="column">
        <Text bold>{cache}</Text>
        <Text>{win}</Text>
        {s.ctx > 0 && <Text dimColor>上下文 {fmtTok(s.ctx)} · 过期重写 {fmtUsd(coldUsd(s))} · 保温 {fmtUsd(hourUsd(s))}/h</Text>}
        {a && <Text><Text bold>{head}</Text>：{a.reason}</Text>}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {s.lastRequestAt > 0 && !s.compacted && <Button key="compact" hotkey="1" label="compact" variant={a?.action === 'compact' ? 'primary' : undefined} onPress={() => panelPress($, s, 'compact')} />}
          {warm && a?.action === 'keepwarm' && a.hours !== 8 && <Button key="advised" hotkey="2" label={`保温 ${a.hours}h`} variant="primary" onPress={() => panelPress($, s, 'advised')} />}
          {warm && <Button key="warm8" hotkey="3" label={s.deadline ? '续到 8h' : '保温 8h'} onPress={() => panelPress($, s, 'warm8')} />}
          {s.deadline > 0 && <Button key="off" hotkey="4" label="关保温" onPress={() => panelPress($, s, 'off')} />}
          {a && <Button key="ignore" hotkey="5" label="不管" onPress={() => panelPress($, s, 'ignore')} />}
          <Button key="close" hotkey="0" label="收起" role="dismiss" onPress={() => { void $.ui.close({ id: PANE }) }} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const la = await read($, leaveAll)
    if (la && !e.props.hasSurvey && (await $.clock.now()) - la.startedAt < TTL_MS) {
      const { Box, Button, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>keepwarm · 离开 {fmtDuration(la.hours * 3_600_000)}（{la.machineOn ? '电脑开着' : '合盖/关机'}）</Text>
            <Text dimColor>  {la.items.length} 个缓存还热的会话{la.collecting ? '，还在收集…' : ''}</Text>
          </Text>
          {la.items.map(i => (
            <Text key={i.sid}>
              <Text bold>{i.project}</Text>{i.topic ? `（${i.topic}）` : ''} <Text dimColor>{fmtTok(i.ctx)}</Text> → <Text bold>{ACTION_ZH[i.action]}</Text>
              <Text dimColor>  {i.reason}（{la.machineOn ? `保温 ${fmtUsd(i.keepUsd)} · ` : ''}compact {fmtUsd(i.compactUsd)} · 不管 {fmtUsd(i.coldUsd)}）</Text>
            </Text>
          ))}
          <Box flexDirection="row" gap={1}>
            <Text dimColor>建议已放到各会话自己的输入框上方，到会话里处理。</Text>
            <Button key="close" hotkey="1" label="关闭" role="dismiss" onPress={() => update($, leaveAll, () => null)} />
          </Box>
        </Box>
      )
    }
    const a = await read($, advice)
    if (!a || e.props.hasSurvey || adviceStale(a, await $.clock.now())) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const L = a.leave
    const head = (L ? `离开 ${fmtDuration(L.hours * 3_600_000)}（${L.machineOn ? '电脑开着' : '合盖/关机'}）· ` : '') +
      { compact: '建议 compact', keepwarm: `建议保温 ${a.hours}h`, ignore: '建议不管' }[a.action]
    const canWarm = !L || L.machineOn
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>keepwarm · {head}</Text>
          {L
            ? <Text dimColor>  上下文 {fmtTok(a.ctx)} · {L.machineOn ? `保温 ${fmtUsd(L.keepUsd)} · ` : ''}compact {fmtUsd(L.compactUsd)} · 不管 {fmtUsd(a.coldUsd)} · 本次判断 {fmtUsd(a.judgeUsd)}</Text>
            : <Text dimColor>  上下文 {fmtTok(a.ctx)} · 过期重写 {fmtUsd(a.coldUsd)} · 保温 {fmtUsd(a.hourUsd)}/h · 本次判断 {fmtUsd(a.judgeUsd)}</Text>}
        </Text>
        <Text dimColor>{a.reason}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="compact" hotkey="1" label="compact" variant={a.action === 'compact' ? 'primary' : undefined} onPress={() => apply($, s, a, 'compact', 'user')} />
          {canWarm && <Button key="warm" hotkey="2" label={`保温 ${a.hours}h`} variant={a.action === 'keepwarm' ? 'primary' : undefined} onPress={() => apply($, s, a, 'keepwarm', 'user')} />}
          <Button key="ignore" hotkey="3" label="不管" role="dismiss" onPress={() => apply($, s, a, 'ignore', 'user')} />
        </Box>
      </Box>
    )
  })
}
