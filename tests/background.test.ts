import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const CTX = 300_000

// The engine beneath: a 300K session on Opus, an idle Mac, and a fork that counts its calls.
function world(on: Parameters<Parameters<typeof test>[1]>[1], cwd = '/tmp/p') {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 14, 20, 0) })
  mock.store(on)
  const forks: string[] = []
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
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.log', async () => ({ value: undefined }) as never)
  on('session.usage', async () => ({ value: { context: { tokens: CTX, window: 1_000_000 } } }) as never)
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('process.run', async () => ({ value: { code: 0, stdout: '', stderr: '' } }) as never)
  on('model.fork', async ($, e) => {
    forks.push(e.prompt.startsWith('[keepwarm 自动检查') ? 'judge' : 'ping')
    return { value: { isAnswered: true, text: '{"action":"keepwarm","topic":"t","reason":"r","hours":3}', usage: { cache_read_input_tokens: CTX, cache_creation_input_tokens: 0, input_tokens: 16, output_tokens: 4 } } } as never
  })
  return { clock, forks }
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
  const { clock, forks } = world(on, '/Users/x/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-10-14-abc')
  await $.session.start({ cwd: '/tmp/p', surface: null, isInteractive: true })
  await turn($, 'composer', '随便聊聊')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'lookup' }] } as never)
  await clock.advance(3 * 60 * MIN)
  expect(forks).toEqual([])
})
