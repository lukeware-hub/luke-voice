// Makes sure the hub is up, starting it detached when it is down, then prints its service token.
// The mod runs this and reads one line of JSON: { ok, serviceToken } or { ok: false, error }.
import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rotateLog } from './engine.mjs'
import { ORIGIN, isOlderVersion, stateFile } from './paths.mjs'
import { proxyEnv } from './proxy.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const VERSION = JSON.parse(readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The mod sends { apiKey, provider } on stdin. Read it with a short limit: a terminal, or an
// empty stdin, gives nothing.
async function readStdin() {
  if (process.stdin.isTTY) return {}
  const chunks = []
  const read = (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk)
  })()
  await Promise.race([read, sleep(1000)])
  try {
    const { apiKey, provider } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return {
      key: typeof apiKey === 'string' ? apiKey.trim() : '',
      provider: provider === 'local' || provider === 'elevenlabs' ? provider : '',
    }
  } catch {
    return {}
  }
}
const { key: stdinKey = '', provider: stdinProvider = '' } = await readStdin()
process.stdin.destroy()

async function health() {
  try {
    const res = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) })
    const body = await res.json()
    return body.app === 'luke-voice' ? body : 'foreign'
  } catch {
    return null
  }
}

function done(out) {
  process.stdout.write(`${JSON.stringify(out)}\n`)
  process.exit(out.ok ? 0 : 1)
}

let up = await health()
if (up === 'foreign') done({ ok: false, error: `outro programa está usando ${ORIGIN}; feche-o ou defina LUKE_VOICE_PORT com outra porta` })

// An older hub is replaced, so an update takes effect at once. A newer one is kept: a mod left
// over from before an update must not take the hub back to its own, older version.
if (up && isOlderVersion(up.version, VERSION) && existsSync(stateFile('hub.json'))) {
  const { serviceToken } = JSON.parse(readFileSync(stateFile('hub.json'), 'utf8'))
  await fetch(`${ORIGIN}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${serviceToken}` } }).catch(() => undefined)
  for (let i = 0; i < 25 && up; i++) {
    await sleep(200)
    up = await health()
  }
  // A hub too old to know /shutdown keeps serving; it is compatible and exits once idle.
}

if (!up) {
  // Past 5 MB the log moves to hub.old.log (the one before is dropped), or it grows forever.
  rotateLog(stateFile('hub.log'))
  const logFd = openSync(stateFile('hub.log'), 'a')
  spawn(process.execPath, [join(here, 'server.mjs')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env,
      // Behind a proxy, the hub downloads the voice through it (hub/proxy.mjs).
      ...proxyEnv(process.env),
      ...(stdinKey ? { ELEVENLABS_API_KEY: stdinKey } : {}),
      ...(stdinProvider ? { LUKE_VOICE_PROVIDER: stdinProvider } : {}),
    },
  }).unref()
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(200)
    up = await health()
  }
  if (!up || up === 'foreign') done({ ok: false, error: `o servidor local não iniciou; veja ${stateFile('hub.log')}` })
}

const { serviceToken } = JSON.parse(readFileSync(stateFile('hub.json'), 'utf8'))
done({ ok: true, serviceToken, version: up.version })
