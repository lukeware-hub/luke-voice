// Makes sure the hub is up, starting it detached when it is down, then prints its service token.
// The mod runs this and reads one line of JSON: { ok, serviceToken } or { ok: false, error }.
import { spawn } from 'node:child_process'
import { openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ORIGIN, stateFile } from './paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))

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

if (!up) {
  const logFd = openSync(stateFile('hub.log'), 'a')
  spawn(process.execPath, [join(here, 'server.mjs')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: process.env,
  }).unref()
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(resolve => setTimeout(resolve, 200))
    up = await health()
  }
  if (!up || up === 'foreign') done({ ok: false, error: `The hub did not start. See ${stateFile('hub.log')}.` })
}

const { serviceToken } = JSON.parse(readFileSync(stateFile('hub.json'), 'utf8'))
done({ ok: true, serviceToken, version: up.version })
