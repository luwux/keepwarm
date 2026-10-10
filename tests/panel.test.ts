import { expect, mock, test } from 'claude-code/testing'

const PANE = { plugin: 'keepwarm', component: 'Pane', requestId: 'keepwarm', props: { title: 'keepwarm', isFocused: false, bodyColumns: 40, placement: 'inline' } } as const

// The phone draws the panel (the band above the prompt is not drawn there): its tree must
// validate on the mobile element table as well as on the desktop's and the terminal's.
for (const surface of ['mobile', 'desktop', 'terminal'] as const) {
  test(`panel draws on ${surface}`, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ type: 'Text', text: '本会话还没有请求' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '没在保温' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  })
}
