// Makes sure the hub is up, starting it detached when it is down, then prints its service token.
// The mod runs this and reads one line of JSON: { ok, serviceToken } or { ok: false, error }.
import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ORIGIN, stateFile } from './paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const VERSION = JSON.parse(readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
if (up === 'foreign') done({ ok: false, error: `Another program is using ${ORIGIN}.` })

// A hub from another version of the plugin is replaced, so an update takes effect at once.
if (up && up.version !== VERSION && existsSync(stateFile('hub.json'))) {
  const { serviceToken } = JSON.parse(readFileSync(stateFile('hub.json'), 'utf8'))
  await fetch(`${ORIGIN}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${serviceToken}` } }).catch(() => undefined)
  for (let i = 0; i < 25 && up; i++) {
    await sleep(200)
    up = await health()
  }
  // A hub too old to know /shutdown keeps serving; it is compatible and exits once idle.
}

if (!up) {
  const logFd = openSync(stateFile('hub.log'), 'a')
  spawn(process.execPath, [join(here, 'server.mjs')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: process.env,
  }).unref()
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(200)
    up = await health()
  }
  if (!up || up === 'foreign') done({ ok: false, error: `The hub did not start. See ${stateFile('hub.log')}.` })
}

const { serviceToken } = JSON.parse(readFileSync(stateFile('hub.json'), 'utf8'))
done({ ok: true, serviceToken, version: up.version })
