export type LinkState = 'off' | 'connecting' | 'up' | 'down'

export type Link = {
  state: LinkState
  name: string | null
  reason: string | null
}

export type Line = { kind: 'sent' | 'queued' | 'note' | 'stop' | 'info'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'luke-voice': { isOn: boolean; link: Shaped<Link>; lines: Shaped<Line[]> }
  }
}
