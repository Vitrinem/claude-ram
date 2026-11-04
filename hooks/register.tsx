import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardState, Group, Proc, Snapshot } from '../types'

type $T = EngineInterface

const PANE = 'ram-inspector'

const snapshot = atom({ plugin: 'ram-inspector', key: 'snapshot' } as const, null, { shape: 'snap-1' })
const guard = atom(
  { plugin: 'ram-inspector', key: 'guard' } as const,
  { enabled: false, high: 85, low: 70, paused: [], log: [], lastAction: 0 },
  { shape: 'guard-1' },
)
const expanded = atom({ plugin: 'ram-inspector', key: 'expanded' } as const, [], { shape: 'exp-1' })
const confirmKill = atom({ plugin: 'ram-inspector', key: 'confirmKill' } as const, 0, { shape: 'ck-1' })
const pausedByMod = atom({ plugin: 'ram-inspector', key: 'pausedByMod' } as const, [], { shape: 'pbm-1' })

const MIN_GUARD_BYTES = 300 * 1024 * 1024
const GUARD_COOLDOWN_MS = 15_000
const MAX_PROCS_SHOWN = 12

// ------------------------------------------------------------------ platform

type Platform = 'win' | 'mac' | 'linux'
type Raw = {
  pid: number
  ppid: number
  rss: number
  cpu: number
  stopped: boolean
  age: number
  name: string
  cmd: string
}

let platform: Platform | null = null
let selfPid = 0
let macTotal = 0
let busy = false

async function detect($: $T): Promise<Platform> {
  if (platform) return platform
  if ((await $.env.get('OS')) === 'Windows_NT') {
    platform = 'win'
    const r = await $.process.run([
      'powershell', '-NoProfile', '-Command',
      '(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId',
    ])
    selfPid = parseInt(r.stdout.trim(), 10) || 0
  } else {
    const u = await $.process.run(['uname', '-s'])
    platform = u.stdout.trim() === 'Darwin' ? 'mac' : 'linux'
    const r = await $.process.run(['sh', '-c', 'echo $PPID'])
    selfPid = parseInt(r.stdout.trim(), 10) || 0
    if (platform === 'mac') {
      const m = await $.process.run(['sysctl', '-n', 'hw.memsize'])
      macTotal = Number(m.stdout.trim()) || 0
    }
  }
  return platform
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

function parseEtime(s: string): number {
  // [[dd-]hh:]mm:ss
  let days = 0
  let rest = s
  const dash = s.indexOf('-')
  if (dash >= 0) {
    days = parseInt(s.slice(0, dash), 10) || 0
    rest = s.slice(dash + 1)
  }
  const nums = rest.split(':').map(n => parseInt(n, 10) || 0)
  while (nums.length < 3) nums.unshift(0)
  const [h = 0, mi = 0, sec = 0] = nums.slice(-3)
  return days * 86400 + h * 3600 + mi * 60 + sec
}

async function scanPosix($: $T): Promise<{ procs: Raw[]; total: number; used: number }> {
  const ps = await $.process.run(['ps', '-axww', '-o', 'pid=,ppid=,rss=,pcpu=,stat=,etime=,args='])
  const procs: Raw[] = []
  for (const line of ps.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const [, pid = '', ppid = '', rss = '', cpu = '', stat = '', etime = '', cmd = ''] = m
    if (cmd.startsWith('ps -axww')) continue
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rss: Number(rss) * 1024,
      cpu: Number(cpu.replace(',', '.')) || 0,
      stopped: stat.startsWith('T'),
      age: parseEtime(etime),
      name: basename(cmd.split(' ')[0] ?? ''),
      cmd,
    })
  }
  let total = 0
  let used = 0
  if (platform === 'mac') {
    const vm = await $.process.run(['vm_stat'])
    const page = Number(vm.stdout.match(/page size of (\d+)/)?.[1] ?? 4096)
    const pages = (label: string) =>
      Number(vm.stdout.match(new RegExp(label + ':\\s+(\\d+)'))?.[1] ?? 0)
    total = macTotal
    const anon = pages('Anonymous pages')
    if (anon > 0) {
      // Activity Monitor's "Memory Used": app memory + wired + compressed
      used = (anon - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page
    } else {
      used = total - (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page
    }
  } else {
    const mi = await $.process.run(['cat', '/proc/meminfo'])
    const kb = (label: string) => Number(mi.stdout.match(new RegExp(label + ':\\s+(\\d+)'))?.[1] ?? 0) * 1024
    total = kb('MemTotal')
    used = total - kb('MemAvailable')
  }
  return { procs, total, used: Math.max(0, used) }
}

const WIN_SCAN =
  "$ErrorActionPreference='SilentlyContinue';$n=Get-Date;$o=Get-CimInstance Win32_OperatingSystem;" +
  '$p=Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{i=$_.ProcessId;p=$_.ParentProcessId;r=$_.WorkingSetSize;' +
  'c=$(if($_.CreationDate){[int]($n-$_.CreationDate).TotalSeconds}else{0});n=$_.Name;e=$_.ExecutablePath;a=$_.CommandLine}};' +
  '@{t=$o.TotalVisibleMemorySize*1024;f=$o.FreePhysicalMemory*1024;p=$p}|ConvertTo-Json -Compress -Depth 3'

async function scanWin($: $T): Promise<{ procs: Raw[]; total: number; used: number }> {
  const r = await $.process.run(['powershell', '-NoProfile', '-Command', WIN_SCAN], { timeoutMs: 20_000 })
  const data = JSON.parse(r.stdout) as {
    t: number
    f: number
    p: Array<{ i: number; p: number; r: number; c: number; n: string | null; e: string | null; a: string | null }>
  }
  const procs: Raw[] = []
  for (const x of data.p) {
    const cmd = x.a || x.e || x.n || ''
    if (cmd.includes('Get-CimInstance Win32_Process')) continue
    procs.push({
      pid: x.i,
      ppid: x.p,
      rss: x.r || 0,
      cpu: 0,
      stopped: false,
      age: x.c || 0,
      name: x.n || basename(x.e || ''),
      cmd: (x.e ? x.e + ' ' : '') + (x.a || ''),
    })
  }
  return { procs, total: data.t, used: data.t - data.f }
}

// ------------------------------------------------------------------ grouping

const NOT_CLAUDE =
  /^(sh|bash|zsh|dash|ksh|fish|env|timeout|flock|nice|sudo|python[\d.]*|perl|ruby|cat|grep|rg|find|ps|cmd\.exe|powershell(\.exe)?|pwsh(\.exe)?)$/

function classify(p: Raw): 'cli' | 'desktop' | null {
  const l = p.cmd.toLowerCase().replace(/\\/g, '/')
  const name = p.name.toLowerCase()
  const argv = l.split(/\s+/)
  // A shell or a tool whose arguments merely mention Claude is not Claude.
  if (NOT_CLAUDE.test(name)) return null
  const isCode =
    l.includes('claude-code') ||
    l.includes('@anthropic-ai/claude') ||
    (/^node(\.exe)?$/.test(name) && basename(argv[1] ?? '') === 'claude')
  if (
    !isCode &&
    (l.includes('claude.app/contents/') || l.includes('anthropicclaude') || (name.includes('claude') && name.includes('helper')))
  ) {
    return 'desktop'
  }
  if (name === 'claude' || name === 'claude.exe' || isCode) return 'cli'
  return null
}

function shortCmd(cmd: string): string {
  const t = cmd.replace(/\/(Users|home)\/[^/\s]+/g, '~').replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '~')
  return t.length > 120 ? t.slice(0, 119) + '…' : t
}

function buildGroups(procs: Raw[], modPaused: Set<number>): Group[] {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const kids = new Map<number, number[]>()
  for (const p of procs) {
    if (p.ppid === p.pid) continue
    const list = kids.get(p.ppid) ?? []
    list.push(p.pid)
    kids.set(p.ppid, list)
  }
  const kind = new Map(procs.map(p => [p.pid, classify(p)]))
  const hasAncestor = (pid: number, k: string) => {
    const seen = new Set<number>()
    let cur = byPid.get(pid)?.ppid
    while (cur && byPid.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      if (kind.get(cur) === k) return true
      cur = byPid.get(cur)?.ppid
    }
    return false
  }
  const tree = (root: number, exclude: Set<number>) => {
    const out: number[] = []
    const seen = new Set<number>()
    const stack = [root]
    while (stack.length) {
      const pid = stack.pop()!
      if (exclude.has(pid) || seen.has(pid)) continue
      seen.add(pid)
      out.push(pid)
      stack.push(...(kids.get(pid) ?? []))
    }
    return out
  }
  const make = (root: number, k: 'session' | 'desktop', members: number[]): Group => {
    const list: Proc[] = members.map(pid => {
      const p = byPid.get(pid)!
      return { pid, rss: p.rss, cpu: p.cpu, paused: p.stopped || modPaused.has(pid), cmd: shortCmd(p.cmd) }
    })
    list.sort((a, b) => b.rss - a.rss)
    const r = byPid.get(root)!
    const rootProc = list.find(x => x.pid === root)!
    return {
      id: root,
      kind: k,
      label: k === 'desktop' ? 'Claude desktop-app' : `Session ${root}`,
      rss: list.reduce((s, x) => s + x.rss, 0),
      cpu: Math.round(list.reduce((s, x) => s + x.cpu, 0)),
      age: r.age,
      count: list.length,
      paused: rootProc.paused,
      isSelf: members.includes(selfPid),
      procs: list.slice(0, MAX_PROCS_SHOWN),
    }
  }

  const groups: Group[] = []
  const inSession = new Set<number>()
  for (const p of procs) {
    if (kind.get(p.pid) !== 'cli' || hasAncestor(p.pid, 'cli')) continue
    const members = tree(p.pid, new Set())
    members.forEach(m => inSession.add(m))
    groups.push(make(p.pid, 'session', members))
  }
  for (const p of procs) {
    if (kind.get(p.pid) !== 'desktop' || inSession.has(p.pid) || hasAncestor(p.pid, 'desktop')) continue
    groups.push(make(p.pid, 'desktop', tree(p.pid, inSession)))
  }
  groups.sort((a, b) => b.rss - a.rss)
  return groups
}

async function treeOf($: $T, pid: number): Promise<number[]> {
  const plat = await detect($)
  const { procs } = plat === 'win' ? await scanWin($) : await scanPosix($)
  const kids = new Map<number, number[]>()
  for (const p of procs) {
    const list = kids.get(p.ppid) ?? []
    list.push(p.pid)
    kids.set(p.ppid, list)
  }
  const out: number[] = []
  const stack = [pid]
  while (stack.length) {
    const cur = stack.shift()!
    if (out.includes(cur)) continue
    out.push(cur)
    stack.push(...(kids.get(cur) ?? []).filter(k => k !== cur))
  }
  return out // parent first
}

// ------------------------------------------------------------------ actions

const WIN_SUSPEND =
  "Add-Type -Name N -Namespace W -MemberDefinition '[DllImport(\"ntdll.dll\")] public static extern int NtSuspendProcess(IntPtr h); " +
  "[DllImport(\"ntdll.dll\")] public static extern int NtResumeProcess(IntPtr h);';"

async function signal($: $T, pids: number[], action: 'pause' | 'resume' | 'kill'): Promise<void> {
  if (pids.length === 0) return
  const plat = await detect($)
  const ids = pids.map(String)
  if (plat === 'win') {
    if (action === 'kill') {
      await $.process.run(['taskkill', '/F', '/T', ...ids.flatMap(id => ['/PID', id])])
    } else {
      const fn = action === 'pause' ? 'NtSuspendProcess' : 'NtResumeProcess'
      await $.process.run([
        'powershell', '-NoProfile', '-Command',
        `${WIN_SUSPEND} foreach($i in @(${ids.join(',')})){ try { [W.N]::${fn}((Get-Process -Id $i).Handle) | Out-Null } catch {} }`,
      ])
    }
  } else if (action === 'pause') {
    await $.process.run(['kill', '-STOP', ...ids])
  } else if (action === 'resume') {
    await $.process.run(['kill', '-CONT', ...[...ids].reverse()])
  } else {
    await $.process.run(['kill', '-CONT', ...ids])
    await $.process.run(['kill', '-TERM', ...ids])
  }
  if (action === 'pause') {
    await update($, pausedByMod, list => [...new Set([...list, ...pids])])
  } else {
    await update($, pausedByMod, list => list.filter(p => !pids.includes(p)))
  }
}

async function act($: $T, pid: number, action: 'pause' | 'resume' | 'kill', only: boolean): Promise<void> {
  const pids = only ? [pid] : await treeOf($, pid)
  if (action !== 'resume' && pids.includes(selfPid)) {
    $.ui.toast('Det ville ramme denne session selv, så det springer jeg over.')
    return
  }
  await signal($, pids, action)
  await refresh($)
}

// ------------------------------------------------------------------ guard

function stamp(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

async function guardTick($: $T, snap: Snapshot): Promise<boolean> {
  const g = await read($, guard)
  if (!g.enabled || snap.memTotal === 0) return false
  const now = await $.clock.now()
  if (now - g.lastAction < GUARD_COOLDOWN_MS) return false
  const pct = (snap.memUsed / snap.memTotal) * 100
  const sessions = snap.groups.filter(x => x.kind === 'session')
  const log = (msg: string) => [...g.log, `${stamp(now)} ${msg}`].slice(-20)

  if (pct >= g.high) {
    const running = sessions.filter(x => !x.paused).sort((a, b) => b.age - a.age) // oldest first
    const candidates = running.slice(1).filter(x => !x.isSelf && x.rss >= MIN_GUARD_BYTES)
    const target = candidates[candidates.length - 1] // newest
    if (!target) return false
    await signal($, await treeOf($, target.id), 'pause')
    await update($, guard, cur => ({
      ...cur,
      paused: [...cur.paused, target.id],
      lastAction: now,
      log: log(`RAM ${pct.toFixed(0)}%: satte session ${target.id} (${fmt(target.rss)}) på pause`),
    }))
    $.ui.toast(`RAM-guard: satte session ${target.id} på pause`)
    return true
  }
  if (pct <= g.low && g.paused.length > 0) {
    const [first, ...rest] = g.paused
    if (first === undefined) return false
    await signal($, await treeOf($, first).catch(() => [first]), 'resume')
    await update($, guard, cur => ({
      ...cur,
      paused: rest,
      lastAction: now,
      log: log(`RAM ${pct.toFixed(0)}%: fortsatte session ${first}`),
    }))
    return true
  }
  return false
}

async function resumeGuardPaused($: $T): Promise<void> {
  const g = await read($, guard)
  for (const pid of g.paused) {
    await signal($, await treeOf($, pid).catch(() => [pid]), 'resume').catch(() => undefined)
  }
  await update($, guard, cur => ({ ...cur, paused: [] }))
}

// ------------------------------------------------------------------ refresh

async function refresh($: $T): Promise<void> {
  if (busy) return
  busy = true
  try {
    const plat = await detect($)
    const { procs, total, used } = plat === 'win' ? await scanWin($) : await scanPosix($)
    const alive = new Set(procs.map(p => p.pid))
    const modPaused = (await read($, pausedByMod)).filter(p => alive.has(p))
    await update($, pausedByMod, () => modPaused)
    await update($, guard, cur => ({ ...cur, paused: cur.paused.filter(p => alive.has(p)) }))
    const groups = buildGroups(procs, new Set(modPaused))
    const snap: Snapshot = {
      at: await $.clock.now(),
      memTotal: total,
      memUsed: used,
      claudeRss: groups.reduce((s, x) => s + x.rss, 0),
      groups,
    }
    await update($, snapshot, () => snap)
    if (await guardTick($, snap)) {
      busy = false
      await refresh($)
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await update($, snapshot, cur => ({
      ...(cur ?? { at: 0, memTotal: 0, memUsed: 0, claudeRss: 0, groups: [] }),
      error: msg.slice(0, 300),
    }))
  } finally {
    busy = false
  }
}

// ------------------------------------------------------------------ drawing

function fmt(bytes: number): string {
  const mb = bytes / 1048576
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function fmtAge(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}t ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}t`
}

function bar(pct: number, width: number): string {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(n) + '░'.repeat(width - n)
}

async function openPane($: $T) {
  return $.ui.open({ id: PANE, title: 'Claude RAM' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ram',
      description: 'Vis hvilke Claude Code-processer der bruger RAM',
    })
    void openPane($)
    void refresh($)
    const ms = (await detect($)) === 'win' ? 6000 : 3000
    $.clock.every(ms, () => void refresh($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await resumeGuardPaused($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'ram' }, async $ => {
    await openPane($)
    await refresh($)
    const snap = await read($, snapshot)
    if (!snap) return { text: 'Claude RAM-panelet er åbnet.' }
    const lines = snap.groups.map(
      g => `${g.label}${g.isSelf ? ' (denne)' : ''}: ${fmt(g.rss)}, ${g.count} ${g.count === 1 ? 'proces' : 'processer'}${g.paused ? ', på pause' : ''}`,
    )
    return {
      text: [`RAM ${fmt(snap.memUsed)} af ${fmt(snap.memTotal)}, Claude bruger ${fmt(snap.claudeRss)}.`, ...lines].join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const g = await read($, guard)
    const open = await read($, expanded)
    const ck = await read($, confirmKill)
    const width = Math.max(10, Math.min(40, (e.viewport?.columns ?? 60) - 20))

    if (!snap) return <Text dimColor>Læser processer…</Text>

    const pct = snap.memTotal ? (snap.memUsed / snap.memTotal) * 100 : 0
    const claudePct = snap.memTotal ? (snap.claudeRss / snap.memTotal) * 100 : 0
    const color = pct >= 90 ? 'error' : pct >= 75 ? 'warning' : 'success'

    const killButton = (pid: number, only: boolean) =>
      ck === pid ? (
        <Button
          key={`kc-${pid}`}
          onPress={() => {
            void update($, confirmKill, () => 0)
            void act($, pid, 'kill', only)
          }}
        >
          Bekræft stop
        </Button>
      ) : (
        <Button key={`k-${pid}`} onPress={() => void update($, confirmKill, () => pid)}>
          Stop
        </Button>
      )

    const pauseButton = (pid: number, paused: boolean, only: boolean) =>
      paused ? (
        <Button key={`r-${pid}`} onPress={() => void act($, pid, 'resume', only)}>
          Fortsæt
        </Button>
      ) : (
        <Button key={`p-${pid}`} onPress={() => void act($, pid, 'pause', only)}>
          Pause
        </Button>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            RAM {pct.toFixed(0)}% <Text dimColor>· {fmt(snap.memUsed)} af {fmt(snap.memTotal)}</Text>
          </Text>
          <Text color={color}>{bar(pct, width)} system</Text>
          <Text color="claude">
            {bar(claudePct, width)} Claude {fmt(snap.claudeRss)}
          </Text>
          {snap.error && <Text color="error">Fejl: {snap.error}</Text>}
        </Box>

        <Box flexDirection="row" gap={1} alignItems="center">
          <Button
            key="guard-toggle"
            onPress={async () => {
              const turningOff = g.enabled
              await update($, guard, cur => ({ ...cur, enabled: !cur.enabled }))
              if (turningOff) await resumeGuardPaused($)
            }}
          >
            {g.enabled ? 'Guard: til' : 'Guard: fra'}
          </Button>
          <Text dimColor>
            pauser nyeste tunge session ved {g.high}% og fortsætter ved {g.low}%
          </Text>
        </Box>
        {g.enabled && g.log.length > 0 && (
          <Box flexDirection="column">
            {g.log.slice(-4).map((line, i) => (
              <Text key={`log-${i}`} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        )}

        {snap.groups.length === 0 && <Text dimColor>Ingen Claude-processer fundet.</Text>}
        {snap.groups.map(grp => {
          const isOpen = open.includes(grp.id)
          return (
            <Box key={`g-${grp.id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                <Text bold>{grp.label}</Text>
                {grp.isSelf && <Text color="claude">denne session</Text>}
                {grp.paused && <Text color="warning">på pause</Text>}
                <Text tabular>{fmt(grp.rss)}</Text>
                <Text dimColor tabular>
                  {grp.cpu}% CPU · {grp.count} proc. · {fmtAge(grp.age)}
                </Text>
              </Box>
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`t-${grp.id}`}
                  onPress={() =>
                    void update($, expanded, list =>
                      list.includes(grp.id) ? list.filter(x => x !== grp.id) : [...list, grp.id],
                    )
                  }
                >
                  {isOpen ? 'Skjul' : 'Vis processer'}
                </Button>
                {!grp.isSelf && grp.kind === 'session' && pauseButton(grp.id, grp.paused, false)}
                {!grp.isSelf && grp.kind === 'session' && killButton(grp.id, false)}
              </Box>
              {isOpen &&
                grp.procs.map(p => (
                  <Box key={`pr-${p.pid}`} flexDirection="row" gap={1}>
                    <Text tabular>{String(p.pid).padStart(7)}</Text>
                    <Text tabular>{fmt(p.rss).padStart(7)}</Text>
                    <Text dimColor tabular>
                      {`${p.cpu.toFixed(0)}%`.padStart(4)}
                    </Text>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text dimColor mono wrap="truncate-end">
                        {p.paused ? '⏸ ' : ''}
                        {p.cmd}
                      </Text>
                    </Box>
                    {p.pid !== grp.id && p.pid !== selfPid && pauseButton(p.pid, p.paused, true)}
                    {p.pid !== grp.id && p.pid !== selfPid && killButton(p.pid, true)}
                  </Box>
                ))}
              {isOpen && grp.count > grp.procs.length && (
                <Text dimColor>… og {grp.count - grp.procs.length} mindre processer</Text>
              )}
            </Box>
          )
        })}
        <Text dimColor>
          Pause stopper CPU og ny RAM, men frigiver ikke det, processen allerede har (systemet kan flytte det til swap). Stop
          frigiver RAM.
        </Text>
      </Box>
    )
  })
}
