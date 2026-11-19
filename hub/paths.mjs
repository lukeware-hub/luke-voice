import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PORT = Number(process.env.LUKE_VOICE_PORT || 4848)
export const ORIGIN = `http://127.0.0.1:${PORT}`

export function stateDir() {
  const dir = process.env.LUKE_VOICE_HOME || join(homedir(), '.luke-voice')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function stateFile(name) {
  return join(stateDir(), name)
}
