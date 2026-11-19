// The luke-voice hub: one local process for every subscribed Claude session and one call window.
// It never calls Claude. It queues a command; the matching session's mod pulls it and runs it.
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { conversationToken, ensureAgent } from './agent.mjs'
import { PORT, stateDir, stateFile } from './paths.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version
const MAX_BODY = 64 * 1024
const MAX_ACTIVITY = 60
const ACK_WAIT_MS = 15_000
const STALE_SESSION_MS = 90_000

const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}

const newSecret = () => randomBytes(24).toString('base64url')

function sameSecret(given, expected) {
  if (typeof given !== 'string' || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function loadSecrets() {
  const file = stateFile('hub.json')
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const secrets = { serviceToken: saved.serviceToken || newSecret(), windowKey: newSecret() }
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  return secrets
}

function chromePath() {
  const candidates =
    process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
          .filter(Boolean)
          .map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
  return candidates.find(path => existsSync(path)) ?? null
}

// A Chrome app window with its own profile, so the mic grant sticks; else the default browser.
export function openWindow(url) {
  const chrome = chromePath()
  const [cmd, args] = chrome
    ? [chrome, [`--app=${url}`, `--user-data-dir=${join(stateDir(), 'chrome')}`, '--window-size=420,660', '--no-first-run']]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

export function createHub({ serviceToken, windowKey, apiKey = '', root = ROOT, open = openWindow, log = () => {} }) {
  const sessions = new Map() // token -> session
  const streams = new Set() // window SSE responses
  const acks = new Map() // command id -> resolve
  let focused = null
  let call = 'idle'
  let key = apiKey
  let agentId = null
  let lastBusy = Date.now()

  const byName = name => [...sessions.values()].find(s => s.name === name)
  const target = name => (name ? byName(name) : byName(focused)) ?? [...sessions.values()][0]

  const roster = () =>
    [...sessions.values()].map(s => ({ name: s.name, cwd: s.cwd, isBusy: s.isBusy, needsYou: s.needsYou }))

  function broadcast(message) {
    const line = `data: ${JSON.stringify(message)}\n\n`
    for (const res of streams) res.write(line)
  }

  const sendRoster = () => broadcast({ type: 'roster', sessions: roster(), focused, call })

  function uniqueName(cwd) {
    const base = (basename(cwd || '') || 'session').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24) || 'session'
    let name = base
    for (let n = 2; byName(name); n++) name = `${base}-${n}`
    return name
  }

  function wake(session) {
    const waiters = session.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  function enqueue(session, command) {
    const id = newSecret().slice(0, 12)
    session.inbox.push({ id, ...command })
    wake(session)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        acks.delete(id)
        resolve({ ok: false, message: `The ${session.name} session did not answer in time.` })
      }, ACK_WAIT_MS)
      acks.set(id, result => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  function drop(session) {
    sessions.delete(session.token)
    wake(session)
    if (focused === session.name) focused = [...sessions.values()][0]?.name ?? null
    if (sessions.size === 0 && call !== 'idle') broadcast({ type: 'end' })
    sendRoster()
  }

  function activityText(session) {
    if (!session) return 'No Claude session is connected.'
    const lines = session.activity.map(a => `${a.kind}: ${a.text}`)
    return `[activity] session ${session.name} (${session.isBusy ? 'Claude is working' : 'Claude is idle'})\n${lines.join('\n') || 'Nothing yet.'}`
  }

  // Routes for a subscribed session's mod, by its session token.
  const sessionRoutes = {
    'POST /events': (session, body) => {
      const events = Array.isArray(body.events) ? body.events.slice(0, 50) : []
      for (const event of events) {
        const item = { kind: String(event.kind ?? 'info').slice(0, 20), text: String(event.text ?? '').slice(0, 2000) }
        session.activity.push(item)
        if (item.kind === 'attention') session.needsYou = true
        if (item.kind === 'done' || item.kind === 'prompt') session.needsYou = false
      }
      session.activity.splice(0, Math.max(0, session.activity.length - MAX_ACTIVITY))
      if (typeof body.isBusy === 'boolean') session.isBusy = body.isBusy
      if (events.length) broadcast({ type: 'activity', session: session.name, events })
      sendRoster()
      return [200, { ok: true }]
    },
    'GET /inbox': async (session, _body, url) => {
      session.seenAt = Date.now()
      const wait = Math.min(Number(url.searchParams.get('wait') || 0), 25_000)
      if (session.inbox.length === 0 && wait > 0) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, wait)
          session.waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      session.seenAt = Date.now()
      if (!sessions.has(session.token)) return [410, { error: 'unsubscribed' }]
      return [200, { commands: session.inbox.splice(0), call, isFocused: focused === session.name }]
    },
    'POST /ack': (_session, body) => {
      const resolve = acks.get(body.id)
      acks.delete(body.id)
      resolve?.({ ok: Boolean(body.ok), message: String(body.message ?? '') })
      return [200, { ok: true }]
    },
    'POST /show': (session, body) => {
      focused = session.name
      const startCall = Boolean(body.call)
      if (streams.size === 0) {
        open(`http://127.0.0.1:${PORT}/?k=${windowKey}${startCall ? '&call=1' : ''}`)
      } else {
        broadcast({ type: 'focus', name: session.name, startCall })
      }
      sendRoster()
      return [200, { ok: true, isWindowOpen: streams.size > 0 }]
    },
    'POST /end': () => {
      broadcast({ type: 'end' })
      return [200, { ok: true }]
    },
    'POST /unsubscribe': session => {
      drop(session)
      return [200, { ok: true }]
    },
  }

  // Routes for the call window, by the window key.
  const windowRoutes = {
    'POST /token': async () => {
      if (!key) return [409, { error: 'No ElevenLabs API key. Set ELEVENLABS_API_KEY or run /plugin configure luke-voice@luke-voice.' }]
      try {
        agentId ??= await ensureAgent(key, root, { log })
        return [200, { token: await conversationToken(key, agentId) }]
      } catch (error) {
        agentId = null
        return [502, { error: String(error.message ?? error) }]
      }
    },
    'POST /command': async (_none, body) => {
      const session = target(body.session)
      if (!session) return [404, { ok: false, message: 'No Claude session is connected.' }]
      if (body.type === 'send') {
        const prompt = String(body.prompt ?? '').trim()
        if (!prompt) return [400, { ok: false, message: 'The prompt is empty.' }]
        const when = body.when === 'after_current' ? 'after_current' : 'now'
        return [200, await enqueue(session, { type: 'send', prompt: prompt.slice(0, 8000), when })]
      }
      if (body.type === 'stop') return [200, await enqueue(session, { type: 'stop' })]
      return [400, { ok: false, message: 'Unknown command.' }]
    },
    'GET /activity': (_none, _body, url) => [200, { text: activityText(target(url.searchParams.get('session'))) }],
    'POST /call': (_none, body) => {
      call = ['idle', 'connecting', 'live', 'error'].includes(body.state) ? body.state : 'idle'
      sendRoster()
      return [200, { ok: true }]
    },
    'POST /focus': (_none, body) => {
      if (byName(body.name)) focused = body.name
      sendRoster()
      return [200, { ok: true }]
    },
  }

  async function readBody(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 })
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const server = createServer(async (req, res) => {
    try {
      const port = server.address()?.port
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
      if (!hosts.includes(req.headers.host)) return send(res, 403, { error: 'host' })
      const origin = req.headers.origin
      if (origin && !hosts.some(host => origin === `http://${host}`)) return send(res, 403, { error: 'origin' })

      const url = new URL(req.url, `http://${req.headers.host}`)
      const route = `${req.method} ${url.pathname}`
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')

      if (route === 'GET /health') {
        return send(res, 200, { app: 'luke-voice', version: VERSION, sessions: sessions.size, isWindowOpen: streams.size > 0, call, hasKey: Boolean(key) })
      }

      if (route === 'POST /subscribe') {
        if (!sameSecret(bearer, serviceToken)) return send(res, 401, { error: 'token' })
        const body = await readBody(req)
        if (!key && typeof body.apiKey === 'string' && body.apiKey.trim()) key = body.apiKey.trim()
        const token = newSecret()
        const session = { token, name: uniqueName(body.cwd), cwd: String(body.cwd ?? ''), inbox: [], waiters: [], activity: [], isBusy: false, needsYou: false, seenAt: Date.now() }
        sessions.set(token, session)
        focused ??= session.name
        sendRoster()
        return send(res, 200, { token, name: session.name, hasKey: Boolean(key) })
      }

      if (sessionRoutes[route]) {
        const session = sessions.get(bearer)
        if (!session) return send(res, 401, { error: 'session' })
        const body = req.method === 'POST' ? await readBody(req) : {}
        const [status, out] = await sessionRoutes[route](session, body, url)
        return send(res, status, out)
      }

      if (route === 'GET /') {
        if (!sameSecret(url.searchParams.get('k'), windowKey)) return send(res, 403, { error: 'key' })
        const page = readFileSync(join(root, 'window', 'index.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(page)
      }

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname]
        const content = readFileSync(join(root, 'window', file))
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        return res.end(content)
      }

      if (route === 'GET /stream') {
        if (!sameSecret(url.searchParams.get('k'), windowKey)) return send(res, 403, { error: 'key' })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        streams.add(res)
        res.write(`data: ${JSON.stringify({ type: 'roster', sessions: roster(), focused, call })}\n\n`)
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        req.on('close', () => {
          clearInterval(ping)
          streams.delete(res)
          if (streams.size === 0) call = 'idle'
        })
        return
      }

      if (windowRoutes[route]) {
        if (!sameSecret(req.headers['x-luke-key'], windowKey)) return send(res, 401, { error: 'key' })
        const body = req.method === 'POST' ? await readBody(req) : {}
        const [status, out] = await windowRoutes[route](null, body, url)
        return send(res, status, out)
      }

      send(res, 404, { error: 'not found' })
    } catch (error) {
      if (res.headersSent) res.end()
      else send(res, error.status ?? 500, { error: String(error.message ?? error) })
    }
  })

  // Drops sessions whose mod stopped polling (a closed or crashed Claude).
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const session of sessions.values()) {
      if (session.waiters.length === 0 && now - session.seenAt > STALE_SESSION_MS) drop(session)
    }
    if (sessions.size > 0 || streams.size > 0) lastBusy = now
  }, 10_000)
  sweep.unref()

  server.on('close', () => clearInterval(sweep))
  server.idleFor = () => Date.now() - lastBusy
  return server
}

// Run directly: listen on the fixed port and exit after ten idle minutes.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { serviceToken, windowKey } = loadSecrets()
  const hub = createHub({ serviceToken, windowKey, apiKey: process.env.ELEVENLABS_API_KEY ?? '', log: line => console.log(line) })
  hub.listen(PORT, '127.0.0.1', () => console.log(`luke-voice hub on 127.0.0.1:${PORT}`))
  setInterval(() => {
    if (hub.idleFor() > 10 * 60_000) process.exit(0)
  }, 60_000).unref()
}
