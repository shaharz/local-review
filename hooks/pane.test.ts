import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const DIFF = [
  'diff --git a/lib/a.ex b/lib/a.ex',
  '--- a/lib/a.ex',
  '+++ b/lib/a.ex',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old line',
  '+new line',
  '',
].join('\n')

const PANE = {
  plugin: 'local-review',
  component: 'Pane',
  requestId: 'local-review',
  props: {
    title: 'Review',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const OPEN = 'mcp__local-review__open_review'

/** Each cwd is its own repo: `/repo` changes lib/a.ex, any other changes lib/b.ex; in `/silent` git diff dies without a word. */
function fakeEngine(on: On) {
  on('process.run', async (_$, e) => {
    const args = e.argv.slice(1).join(' ')
    const cwd = e.init?.cwd ?? '/repo'
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args.startsWith('rev-parse --show-toplevel')) return out(`${cwd}\n`)
    if (args.startsWith('diff') && cwd === '/silent') return { value: { ...out('').value, exitCode: 1 } }
    if (args.startsWith('diff')) return out(cwd === '/repo' ? DIFF : DIFF.replaceAll('lib/a.ex', 'lib/b.ex'))

    return out('')
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('session.start', async () => ({ cwd: '/repo' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
}

test('comment on a line, then S sends the review to Claude', async ($, on) => {
  fakeEngine(on)
  const submitted: string[] = []
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'local-review', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    submitted.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.resize({ columns: 100, rows: 20, in: 'viewer' })
    expect(await ui.find({ in: 'viewer', text: 'lib/a.ex' })).toBeDefined()

    await ui.key({ key: 'j', in: 'viewer' })
    await ui.key({ key: 'j', in: 'viewer' })
    await ui.key({ key: 'j', in: 'viewer' })
    await ui.key({ key: 'c', in: 'viewer' })
    for (const ch of 'nit') await ui.key({ key: ch, in: 'viewer' })
    await ui.key({ key: 'return', in: 'viewer' })
    expect(await ui.find({ in: 'viewer', text: '◆ nit' })).toBeDefined()

    await ui.key({ key: 'S', in: 'viewer' })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('### lib/a.ex\n- **L2** `new line`\n  > nit')
    expect(await ui.find({ in: 'viewer', text: '◆ nit' })).toBeUndefined()
    await ui.unmount()
  }
})

test('s suggests a replacement prefilled with the line, P puts it in the prompt', async ($, on) => {
  fakeEngine(on)
  const filled: string[] = []
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)

    return { isFilled: true } as never
  })

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'local-review', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 100, rows: 20, in: 'viewer' })

  for (const k of ['j', 'j', 'j', 's']) await ui.key({ key: k, in: 'viewer' })
  expect(await ui.find({ in: 'viewer', text: /suggest> new line/ })).toBeDefined()
  await ui.key({ key: 'backspace', in: 'viewer' })
  await ui.key({ key: 'return', in: 'viewer' })
  await ui.key({ key: 'P', in: 'viewer' })

  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('- **L2 suggestion**: replace `new line` with:\n  ```\n  new lin\n  ```')
})

test('the cancel button drops a comment being typed', async ($, on) => {
  fakeEngine(on)
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'local-review', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 100, rows: 20, in: 'viewer' })

  for (const k of ['j', 'j', 'j', 'c', 'h', 'i']) await ui.key({ key: k, in: 'viewer' })
  expect(await ui.find({ in: 'viewer', text: /comment> hi/ })).toBeDefined()
  await ui.press({ key: 'cancel' })

  expect(await ui.find({ in: 'viewer', text: /comment> / })).toBeUndefined()
  expect(await ui.find({ in: 'viewer', key: 'cancel' })).toBeUndefined()
  await ui.key({ key: 'return', in: 'viewer' })
  expect(await ui.find({ in: 'viewer', text: '◆' })).toBeUndefined()
})

test('Esc arriving as a raw byte cancels a comment; other control bytes are not typed', async ($, on) => {
  fakeEngine(on)
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'local-review', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 100, rows: 20, in: 'viewer' })

  for (const k of ['j', 'j', 'j', 'c', 'h', '\u001b[1;3A', 'i']) await ui.key({ key: k, in: 'viewer' })
  expect(await ui.find({ in: 'viewer', text: /comment> h\[1;3Ai/ })).toBeDefined()
  await ui.key({ key: '\u001b', in: 'viewer' })
  expect(await ui.find({ in: 'viewer', text: /comment> / })).toBeUndefined()
})

test('a second review opens in its own tab and the first keeps its comments', async ($, on) => {
  fakeEngine(on)
  const submitted: string[] = []
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'local-review', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 100, rows: 20, in: 'viewer' })

  for (const k of ['j', 'j', 'j', 'c', 'n', 'i', 't', 'return']) await ui.key({ key: k, in: 'viewer' })
  expect(await ui.find({ in: 'viewer', key: 'tab-1' })).toBeUndefined()

  await $.command.run({ command: 'local-review', args: 'uncommitted' } as never)
  expect(await ui.find({ in: 'viewer', key: 'tab-1' })).toBeUndefined()
  expect(await ui.find({ in: 'viewer', text: '◆ nit' })).toBeDefined()

  const opened = await $.tool.call({ tool: OPEN, cwd: '/other' } as never)
  expect(JSON.stringify(opened)).toContain('tab 2 of 2')
  expect(await ui.find({ in: 'viewer', text: /lib\/b\.ex/ })).toBeDefined()
  expect(await ui.find({ in: 'viewer', text: '◆ nit' })).toBeUndefined()
  expect((await ui.find({ in: 'viewer', key: 'tab-1' }))?.text).toContain('repo ●1')
  expect((await ui.find({ in: 'viewer', key: 'tab-2' }))?.text).toContain('other')

  await ui.key({ key: '1', in: 'viewer' })
  expect(await ui.find({ in: 'viewer', text: '◆ nit' })).toBeDefined()
  await ui.press({ key: 'tab-2' })
  expect(await ui.find({ in: 'viewer', text: /lib\/b\.ex/ })).toBeDefined()
  await ui.press({ key: 'tab-1' })

  await ui.key({ key: 'S', in: 'viewer' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('(repo: /repo)')
  expect(submitted[0]).toContain('> nit')
})

test('a review opened while a comment is being typed waits in its tab', async ($, on) => {
  fakeEngine(on)
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'local-review', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 100, rows: 20, in: 'viewer' })

  for (const k of ['j', 'j', 'j', 'c', 'h', 'i']) await ui.key({ key: k, in: 'viewer' })
  await $.tool.call({ tool: OPEN, cwd: '/other' } as never)

  expect(await ui.find({ in: 'viewer', text: /comment> hi/ })).toBeDefined()
  expect(await ui.find({ in: 'viewer', text: /lib\/a\.ex/ })).toBeDefined()
  expect(await ui.find({ in: 'viewer', key: 'tab-2' })).toBeDefined()
})

test('w closes the tab in view, and the pane with the last one', async ($, on) => {
  fakeEngine(on)
  const closed: string[] = []
  on('ui.close', async (_$, e) => {
    closed.push(e.id)

    return { value: undefined } as never
  })

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'local-review', args: '' } as never)
  await $.tool.call({ tool: OPEN, cwd: '/other' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 100, rows: 20, in: 'viewer' })
  expect(await ui.find({ in: 'viewer', text: /lib\/b\.ex/ })).toBeDefined()

  await ui.key({ key: 'w', in: 'viewer' })
  expect(await ui.find({ in: 'viewer', text: /lib\/a\.ex/ })).toBeDefined()
  expect(await ui.find({ in: 'viewer', key: 'tab-1' })).toBeUndefined()
  expect(closed).toHaveLength(0)

  await ui.key({ key: 'w', in: 'viewer' })
  expect(closed).toEqual(['local-review'])
})

test('a tab comes back on the line it was left on', async ($, on) => {
  fakeEngine(on)
  const submitted: string[] = []
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })

  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await $.command.run({ command: 'local-review', args: '' } as never)
  await $.tool.call({ tool: OPEN, cwd: '/other' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 100, rows: 20, in: 'viewer' })

  for (const k of ['1', 'j', 'j', 'j', '2', 'j', '1', 'c', 'x', 'return', 'S']) await ui.key({ key: k, in: 'viewer' })

  expect(submitted[0]).toContain('### lib/a.ex\n- **L2** `new line`')
})

test('a git call that fails without saying why is shown as an error, not as an empty review', async ($, on) => {
  fakeEngine(on)
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  const answer = await $.command.run({ command: 'local-review', args: '--cwd /silent' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 100, rows: 20, in: 'viewer' })

  expect(JSON.stringify(answer)).toContain('Could not load uncommitted changes in silent: git diff exited 1')
  expect(await ui.find({ in: 'viewer', text: /git diff exited 1/ })).toBeDefined()
})
