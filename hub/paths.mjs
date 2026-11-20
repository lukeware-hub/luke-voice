import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// True when version a is older than version b ("0.7.3" < "0.7.10"). Unknown versions are never older.
export function isOlderVersion(a, b) {
  const parse = v => String(v ?? '').split('.').map(n => Number.parseInt(n, 10))
  const [x, y] = [parse(a), parse(b)]
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  }
  return false
}

// Whether the module at `metaUrl` is the script node was started with (`argv1`). Node gives the
// module its real path, while argv keeps the path as typed: through a symlinked or junctioned
// ~/.claude they differ, and comparing them as text would skip the whole script.
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false
  const real = path => {
    try {
      return realpathSync.native(path)
    } catch {
      return path
    }
  }
  const [a, b] = [real(fileURLToPath(metaUrl)), real(argv1)]
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
