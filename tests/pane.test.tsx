import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ram-inspector',
  component: 'Pane',
  requestId: 'ram-inspector',
  props: {
    title: 'Claude RAM',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PS = [
  '  100     1  200000  1.0 S    01:00:00 /Applications/Claude.app/Contents/MacOS/Claude',
  '  200   100  900000  5.0 S       10:00 /Users/x/Library/Application Support/Claude/claude-code/2.1.0/claude',
  '  201   200 2000000 50.0 S       05:00 node build.js',
  '  300     1  500000  2.0 S  1-02:00:00 claude',
  '  301   300    1000  0.0 S       00:01 sh -c echo',
  '  400     1    1000  0.0 S       00:10 /usr/bin/vim notes.txt',
].join('\n')

const VM = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               10000.',
  'Anonymous pages:                         500000.',
  'Pages purgeable:                              0.',
  'Pages wired down:                        100000.',
  'Pages occupied by compressor:                 0.',
].join('\n')

function ok(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

test('the pane groups Claude processes into sessions and marks this one', async ($, on) => {
  const signals: string[][] = []
  on('command.register', () => ({ value: { command: 'ram' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: {} }))
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    if (cmd === 'uname') return ok('Darwin\n')
    if (cmd === 'sh') return ok('300\n')
    if (cmd === 'sysctl') return ok(String(16 * 1024 ** 3))
    if (cmd === 'vm_stat') return ok(VM)
    if (cmd === 'ps') return ok(PS)
    if (cmd === 'kill') signals.push([...e.argv])
    return ok('')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'ram' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Session 200/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Session 300/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude desktop-app/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /denne session/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /vim/ })).toBeUndefined()
    // session 200 holds itself and its build child: 900000 + 2000000 KB
    expect(await ui.find({ type: 'Text', text: /^2\.8 GB$/ })).toBeDefined()
    // this session has no pause button; the other one does
    expect(await ui.find({ key: 'p-200' })).toBeDefined()
    expect(await ui.find({ key: 'p-300' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'p-200' })
  expect(signals[0]).toEqual(['kill', '-STOP', '200', '201'])
  await ui.unmount()
})

test('the guard pauses the newest heavy session when RAM is high, never this one', async ($, on) => {
  const signals: string[][] = []
  const highVm = VM.replace('Anonymous pages:                         500000.', 'Anonymous pages:                         800000.')
  on('command.register', () => ({ value: { command: 'ram' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: {} }))
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    if (cmd === 'uname') return ok('Darwin\n')
    if (cmd === 'sh') return ok('300\n')
    if (cmd === 'sysctl') return ok(String(16 * 1024 ** 3))
    if (cmd === 'vm_stat') return ok(highVm)
    if (cmd === 'ps') return ok(PS)
    if (cmd === 'kill') signals.push([...e.argv])
    return ok('')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'guard-toggle' })
  await $.command.run({ command: 'ram' })
  expect(signals).toEqual([['kill', '-STOP', '200', '201']])

  // turning the guard off resumes what it paused
  await ui.press({ key: 'guard-toggle' })
  expect(signals[1]).toEqual(['kill', '-CONT', '201', '200'])
  await ui.unmount()
})
