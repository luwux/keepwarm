import { expect, mock, test } from 'claude-code/testing'

test('autorun can be set, read back and turned off', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const run = async (args: string) => (await $.command.run({ command: 'keepwarm', args })).text ?? ''
  expect(await run('autorun 2')).toContain('2 分钟内')
  expect(await run('autorun')).toContain('提醒发出 2 分钟内没回应')
  expect(await run('autorun soon')).toContain('用法')
  expect(await run('autorun off')).toContain('已关')
  expect(await run('autorun')).toContain('自动照办：关')
})
