import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const CTX = 300_000

// The engine beneath: a 300K session on Opus, an idle Mac, and a fork that counts its calls.
type World = { cwd?: string; verdict?: string; judgeMs?: number; now?: number; idleS?: number; store?: Record<string, unknown>; ctx?: number; power?: { dark: boolean }; judgeCold?: boolean }
function world(on: Parameters<Parameters<typeof test>[1]>[1], { cwd = '/tmp/p', verdict = 'keepwarm', judgeMs = 0, now = Date.UTC(2026, 9, 14, 20, 0), idleS = 0, store = {}, ctx = CTX, power = { dark: false }, judgeCold = false }: World = {}) {
  const clock = mock.clock(on, { now })
  mock.store(on, store)
  const forks: string[] = []
  const logs: string[] = []
  const compactions: number[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'sid-1' }))
  on('session.cwd', async () => ({ value: cwd }))
  on('session.surfaces', async () => ({ value: [] }))
  on('command.register', async () => ({ value: { command: 'keepwarm' } }))
  on('tool.register', async () => ({ value: { tool: 'keepwarm' } }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  on('tool.call', async () => ({ result: 'Command running in background with ID: b1.' }) as never)
  on('classic.Stop', async () => ({}))
  on('classic.SessionStart', async () => ({}))
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.log', async (_$, e) => { logs.push((e as { text: string }).text); return { value: undefined } as never })
  on('session.usage', async () => ({ value: { context: { tokens: ctx, window: 1_000_000 } } }) as never)
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('process.run', async (_$, e) => {
    // pmset: a dark wake has no graphics; ioreg: seconds since the last input
    if ((e as { argv: string[] }).argv[0] === 'pmset') return { value: { exitCode: 0, stdout: `Current System Capabilities are: CPU ${power.dark ? 'Disk' : 'Graphics Audio'} Network \n`, stderr: '' } } as never
    return { value: { exitCode: 0, stdout: `"HIDIdleTime" = ${idleS * 1e9}`, stderr: '' } } as never
  })
  on('session.compact', async () => {
    compactions.push(await clock.now())
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never
  })
  on('model.fork', async ($, e) => {
    const judge = e.prompt.startsWith('[keepwarm 自动检查')
    forks.push(judge ? 'judge' : 'ping')
    if (judge && judgeMs) await clock.sleep(judgeMs)
    return { value: { isAnswered: true, text: `{"action":"${verdict}","topic":"t","reason":"r","hours":3}`, usage: judge && judgeCold ? { cache_read_input_tokens: 50_000, cache_creation_input_tokens: CTX - 50_000, input_tokens: 16, output_tokens: 4 } : { cache_read_input_tokens: CTX, cache_creation_input_tokens: 0, input_tokens: 16, output_tokens: 4 } } } as never
  })
  return { clock, forks, compactions, logs }
}

async function turn($: Parameters<Parameters<typeof test>[1]>[0], kind: string, text: string) {
  await $.prompt.submit({ text, origin: { kind } } as never)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' } as never)
}

test('background work keeps the session warm without a judge until it reports', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const { clock, forks } = world(on)
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '跑一个 3 小时的评测')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'Test-set eval' }] } as never)

  await clock.advance(50 * MIN)
  expect(forks).toEqual([]) // no judge: the work will wake the session

  await clock.advance(6 * MIN)
  expect(forks).toEqual(['ping']) // 55 minutes after the last request

  // The work reports: that turn ends the window, and nothing is compacted.
  await turn($, 'task-notification', '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)

  // Quiet again with nothing running: the window is gone and the 50-minute judge is back.
  await clock.advance(50 * MIN)
  expect(forks).toEqual(['ping', 'judge'])
})

test('a background sleep is the session waking itself: no judge and no ping', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const { clock, forks } = world(on)
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await $.prompt.submit({ text: '每 55 分钟醒一次', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 3300; date', run_in_background: true } as never)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'sleep', command: 'sleep 3300; date' }] } as never)

  await clock.advance(56 * MIN)
  expect(forks).toEqual([])
})

test('a session with no project (a chat) gets no idle check at all', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const { clock, forks } = world(on, { cwd: '/Users/x/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-10-14-abc' })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '随便聊聊')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'lookup' }] } as never)
  await clock.advance(3 * 60 * MIN)
  expect(forks).toEqual([])
})

test('a rewrite after the hour is one notice in Claude, and nothing shows under the prompt', { options: { idleCheck: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 14, 20, 0) })
  mock.store(on)
  const notices: string[] = []
  const toasts: string[] = []
  const footer: Array<string | undefined> = []
  let usage = { cache_read_input_tokens: CTX, cache_creation_input_tokens: 0, input_tokens: 10, output_tokens: 100, model: 'claude-opus-5-5' }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'sid-2' }))
  on('session.cwd', async () => ({ value: '/tmp/p' }))
  on('session.surfaces', async () => ({ value: [] }))
  on('command.register', async () => ({ value: { command: 'keepwarm' } }))
  on('tool.register', async () => ({ value: { tool: 'keepwarm' } }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.usage', async () => ({ value: { context: { tokens: CTX, window: 1_000_000 } } }) as never)
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('ui.status', async (_$, e) => { footer.push((e as { text?: string }).text); return { value: undefined } as never })
  on('ui.toast', async (_$, e) => { toasts.push((e as { text: string }).text); return { value: undefined } as never })
  on('ui.log', async () => ({ value: undefined }) as never)
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === 'terminal-notifier') notices.push(argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  async function step(text: string) {
    await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5' } as never)) { /* drain */ }
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' } as never)
  }
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await step('第一条')
  await step('一分钟后，热的')
  expect(toasts).toEqual([])
  expect(footer.at(-1)).toBeUndefined()

  await clock.advance(2 * 60 * MIN)
  expect(footer.filter(x => x !== undefined)).toEqual([])
  usage = { ...usage, cache_read_input_tokens: 40_000, cache_creation_input_tokens: CTX - 40_000 }
  await step('两小时后回来')
  expect(toasts.filter(x => x.startsWith('冷写入'))).toHaveLength(1)
  expect(toasts.at(-1)).toContain('缓存过期')
  expect(notices).toEqual([]) // no Mac notification
  expect(footer.filter(x => x !== undefined)).toEqual([])
})

test('a judged compaction waits out the hour the judge refreshed, with no ping before it', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const { clock, forks, compactions } = world(on, { verdict: 'compact', judgeMs: 8000 }) // the judge's fork takes 8 s, as it did (10-15)
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '先到这里')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  const start = await clock.now()

  await clock.advance(50 * MIN + 10_000)
  expect(forks).toEqual(['judge'])
  expect(compactions).toEqual([])

  await clock.advance(56 * MIN)
  expect(forks).toEqual(['judge']) // no ping at the end of the hour
  expect(compactions).toHaveLength(1)
  expect(compactions[0] - start).toBeLessThan(50 * MIN + 56 * MIN) // inside the hour the judge refreshed
})

test('a session judged worth keeping warm stays warm at night, with the Mac idle', { options: { idleCheck: 'judge' } }, async ($, on) => {
  // 1 a.m. here, nobody at the Mac for two hours: no sign of bed (10-15, the person slept at 4).
  const { clock, forks, compactions } = world(on, { now: new Date(2026, 9, 15, 1, 0).getTime(), idleS: 2 * 3600 })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '等我回来再接着看')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)

  await clock.advance(3 * 60 * MIN)
  expect(forks).toEqual(['judge', 'ping', 'ping']) // judged at 50 minutes, pinged at 105 and 160
  expect(compactions).toEqual([])
})

// A rewind starts the conversation again under a new id; the engine dates its cache from the
// transcript's last response, 2h20m back, but keepwarm pinged the original 36 minutes ago (10-16).
const NOW = Date.UTC(2026, 9, 16, 7, 11)
const fork = { stop_hook_active: false, source: 'fork', seconds_since_last_response: 8460, context_tokens: CTX, prompt_cache_likely_expired: true, estimated_cache_write_usd: 2.08 }

test('a rewound session whose original keepwarm pinged within the hour is not told its cache is cold', async ($, on) => {
  const parent = { lastRequestAt: NOW - 36 * MIN, turnAt: NOW - 141 * MIN, ctx: CTX, window: 1_000_000, model: 'claude-opus-5-5', compacted: false }
  const { logs } = world(on, { now: NOW, store: { 'rt:sid-parent': parent } })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await $.classic.SessionStart(fork as never)
  expect(logs.filter(x => x.includes('缓存已冷'))).toEqual([])
})

test('a resumed session does not take another session of the same size for its own', async ($, on) => {
  // Another conversation, about as large, pinged 20 minutes ago; this one last answered 70 minutes ago.
  const other = { lastRequestAt: NOW - 20 * MIN, turnAt: NOW - 3 * 60 * MIN, ctx: CTX + 1000, window: 1_000_000, model: 'claude-opus-5-5', compacted: false }
  const { logs } = world(on, { now: NOW, store: { 'rt:sid-other': other } })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await $.classic.SessionStart({ ...fork, source: 'resume', seconds_since_last_response: 70 * 60 } as never)
  expect(logs.filter(x => x.includes('缓存已冷'))).toHaveLength(1)
})

test('a fork does not take a session with another last turn for its parent', async ($, on) => {
  const other = { lastRequestAt: NOW - 20 * MIN, turnAt: NOW - 3 * 60 * MIN, ctx: CTX, window: 1_000_000, model: 'claude-opus-5-5', compacted: false }
  const { logs } = world(on, { now: NOW, store: { 'rt:sid-other': other } })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await $.classic.SessionStart(fork as never)
  expect(logs.filter(x => x.includes('缓存已冷'))).toHaveLength(1)
})

test('a rewound session nothing kept warm is told its cache is cold', async ($, on) => {
  const { logs } = world(on, { now: NOW })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await $.classic.SessionStart(fork as never)
  expect(logs.filter(x => x.includes('缓存已冷'))).toHaveLength(1)
})

test('a session under the 200K threshold is left alone: no judge, no ping, no compaction', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const { clock, forks, compactions } = world(on, { ctx: 190_000 })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '跑一个 3 小时的评测')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'Test-set eval' }] } as never)
  await clock.advance(13 * 60 * MIN)
  expect(forks).toEqual([])
  expect(compactions).toEqual([])
})

// The lid closed: the Mac wakes for seconds of maintenance and sleeps again; a request sent then is
// retried on the full wake, after the cache lapsed (10-15, a judge that wrote 404K tokens).
test('nothing is sent during a dark wake; the judge waits for the full wake', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const power = { dark: true }
  const { clock, forks } = world(on, { power })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '等我回来')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  await clock.advance(53 * MIN)
  expect(forks).toEqual([])
  power.dark = false
  await clock.advance(2 * MIN)
  expect(forks).toEqual(['judge'])
})

test('a keep-warm ping is held during a dark wake and goes out on the full wake', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const power = { dark: false }
  const { clock, forks } = world(on, { power })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '等我回来')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  await clock.advance(51 * MIN)
  expect(forks).toEqual(['judge'])
  power.dark = true
  await clock.advance(56 * MIN)
  expect(forks).toEqual(['judge'])
  power.dark = false
  await clock.advance(2 * MIN)
  expect(forks).toEqual(['judge', 'ping'])
})

test('a watch on a published artifact is not background work: the session is judged as usual', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const { clock, forks } = world(on)
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '发布好了')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'w1', type: 'monitor', status: 'running', description: 'live updates for artifact https://claude.ai/artifact/x (republishes, comments)' }] } as never)
  await clock.advance(51 * MIN)
  expect(forks).toEqual(['judge'])
})

test('after a restart the background work of the old process is not waited for', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const now = Date.UTC(2026, 9, 17, 10, 0)
  const rt = { lastRequestAt: now - 2 * MIN, turnAt: now - 2 * MIN, ctx: CTX, window: 1_000_000, model: 'claude-opus-5-5', compacted: false }
  const { clock, forks } = world(on, { now, store: { 'rt:sid-1': rt, 'bg:sid-1': ['Wait for G1 s0 to finish'] } })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await $.classic.SessionStart({ ...fork, source: 'resume', seconds_since_last_response: 120, prompt_cache_likely_expired: false } as never)
  await clock.advance(49 * MIN)
  expect(forks).toEqual(['judge']) // judged as idle, not kept warm for a shell that died
})

// The session's own cron: a one-shot wakeup 55 minutes on (as ScheduleWakeup records one), in local time.
function cronAt(ms: number) {
  const d = new Date(ms)
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
}

test('a cron of its own that fires before the cache lapses: no judge, no ping', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const now = Date.UTC(2026, 9, 17, 10, 0)
  const { clock, forks } = world(on, { now })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '一小时内再看一次')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [{ id: 'c1', schedule: cronAt(now + 55 * MIN), recurring: false, prompt: 'check' }] } as never)
  await clock.advance(55 * MIN)
  expect(forks).toEqual([])
})

test('a wakeup that does not come: judged just after it was due', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const now = Date.UTC(2026, 9, 17, 10, 0)
  const { clock, forks } = world(on, { now })
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '一小时内再看一次')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [{ id: 'c1', schedule: cronAt(now + 55 * MIN), recurring: false, prompt: 'check' }] } as never)
  await clock.advance(57 * MIN)
  expect(forks).toEqual(['judge'])
})

test('a daily cron is no wakeup within the hour: judged as usual', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const { clock, forks } = world(on)
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '每天早上九点汇报')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'report' }] } as never)
  await clock.advance(51 * MIN)
  expect(forks).toEqual(['judge'])
})

test('an idle teammate is not background work: judged as usual', { options: { idleCheck: 'judge' } }, async ($, on) => {
  const { clock, forks } = world(on)
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '先这样')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 't1', type: 'teammate', status: 'idle', description: 'researcher' }] } as never)
  await clock.advance(51 * MIN)
  expect(forks).toEqual(['judge'])
})

// 10-19: the server dropped caches within the hour; a judge then wrote the whole context again,
// a ping five minutes later read the judge's copy, and the person's next message wrote it once more.
for (const verdict of ['keepwarm', 'compact']) {
  test(`a judge that finds the cache gone (${verdict}): no ping and no compaction after it`, { options: { idleCheck: 'judge' } }, async ($, on) => {
    const { clock, forks, compactions } = world(on, { verdict, judgeCold: true })
    await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
    await turn($, 'composer', '先到这里')
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)

    await clock.advance(6 * 60 * MIN)
    expect(forks).toEqual(['judge'])
    expect(compactions).toEqual([])
  })
}
