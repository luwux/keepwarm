export type KeepwarmAdvice = {
  action: 'compact' | 'keepwarm' | 'ignore'
  reason: string
  // What the session is about, in a few words (for notifications).
  topic?: string
  instructions: string
  hours: number
  ctx: number
  coldUsd: number | null
  hourUsd: number | null
  judgeUsd: number | null
  at: number
  auto: boolean
  // Set when the person said they are leaving (/keepwarm leave).
  leave?: { hours: number; machineOn: boolean; keepUsd: number | null; compactUsd: number | null }
}

export type KeepwarmLeaveItem = {
  sid: string
  project: string
  topic: string
  ctx: number
  action: 'compact' | 'keepwarm' | 'ignore'
  reason: string
  keepUsd: number | null
  compactUsd: number | null
  coldUsd: number | null
}

export type KeepwarmLeaveAll = {
  id: string
  hours: number
  machineOn: boolean
  startedAt: number
  items: KeepwarmLeaveItem[]
  collecting: boolean
}

declare module 'claude-code' {
  interface PluginState {
    // panel: a counter bumped to redraw the panel (its countdown, a window started or stopped).
    keepwarm: { advice: KeepwarmAdvice | null; leaveAll: KeepwarmLeaveAll | null; panel: number }
  }
}
