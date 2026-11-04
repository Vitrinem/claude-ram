export type Proc = {
  pid: number
  rss: number
  cpu: number
  paused: boolean
  cmd: string
}

export type Group = {
  id: number
  kind: 'session' | 'desktop'
  label: string
  rss: number
  cpu: number
  age: number
  count: number
  paused: boolean
  isSelf: boolean
  procs: Proc[]
}

export type Snapshot = {
  at: number
  memTotal: number
  memUsed: number
  claudeRss: number
  groups: Group[]
  error?: string
}

export type GuardState = {
  enabled: boolean
  high: number
  low: number
  /** Root PIDs the guard paused, oldest first. */
  paused: number[]
  log: string[]
  lastAction: number
}

declare module 'claude-code' {
  interface PluginState {
    'ram-inspector': {
      snapshot: Shaped<Snapshot | null>
      guard: Shaped<GuardState>
      expanded: Shaped<number[]>
      confirmKill: Shaped<number>
      /** PIDs this mod paused (Windows reports no stopped state of its own). */
      pausedByMod: Shaped<number[]>
    }
  }
}
