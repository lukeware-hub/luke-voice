export type LinkState = 'off' | 'connecting' | 'up' | 'down'

export type Link = {
  state: LinkState
  name: string | null
  reason: string | null
}

export type Line = {
  kind: 'sent' | 'queued' | 'note' | 'stop' | 'info' | 'task' | 'result' | 'failure'
  text: string
  /** When it happened, epoch ms. */
  at: number
}

/** A voice task whose subagent is working now. */
export type Running = { key: string; task: string; startedAt: number }

/** The last tool call of the main Claude session. */
export type LastTool = { text: string; isFailed: boolean; at: number } | null

declare module 'claude-code' {
  interface PluginState {
    'luke-voice': {
      isOn: boolean
      link: Shaped<Link>
      lines: Shaped<Line[]>
      running: Shaped<Running[]>
      lastTool: Shaped<LastTool>
    }
  }
}
