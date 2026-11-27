// Finished work Ceci still has to tell the user. A voice task's result reaches the window only
// over its event stream; a window closed, reconnecting or reloaded at that moment would miss it.
// Kept here, on disk, until the window says it handed the result to the voice (POST /notice-ack),
// and sent again to every window that connects meanwhile.
import { readFileSync, writeFileSync } from 'node:fs'

// A result older than this is no longer news: it is dropped instead of said.
export const NOTICE_MAX_AGE_MS = 6 * 60 * 60_000
const MAX_NOTICES = 20
// A result the window already handed to the voice, sent again this soon (the mod keeps a result it
// could not confirm and sends it once more), is the same notice: it is not told a second time.
export const NOTICE_REPEAT_MS = 2 * 60_000

export function createNotices({ file = null, clock = Date.now, maxAgeMs = NOTICE_MAX_AGE_MS, repeatMs = NOTICE_REPEAT_MS } = {}) {
  let items = []
  let next = 1
  // Acked notices, kept in memory for repeatMs only, so a copy sent again is recognized.
  let heard = []
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(saved)) items = saved.filter(n => n && typeof n.id === 'string' && typeof n.text === 'string')
    } catch {
      // No file yet, or a broken one: start empty.
    }
  }
  for (const n of items) next = Math.max(next, Number(String(n.id).replace(/^n/, '')) + 1 || next)

  const save = () => {
    if (!file) return
    try {
      writeFileSync(file, JSON.stringify(items), { mode: 0o600 })
    } catch {
      // Kept in memory still; only a hub restart would lose it.
    }
  }
  const fresh = () => {
    const since = clock() - maxAgeMs
    const kept = items.filter(n => n.at >= since)
    if (kept.length !== items.length) {
      items = kept
      save()
    }
    return items
  }

  return {
    // A result to tell: the same text for the same session is one notice.
    add(session, text) {
      const known = fresh().find(n => n.session === session && n.text === text)
      if (known) return known
      // Already told a moment ago: the same notice again, marked so the hub does not tell it twice.
      const since = clock() - repeatMs
      heard = heard.filter(n => n.ackedAt >= since)
      const told = heard.find(n => n.session === session && n.text === text)
      if (told) return { id: told.id, session, text, at: told.at, isHeard: true }
      const notice = { id: `n${next++}`, session, text, at: clock() }
      items = [...items, notice].slice(-MAX_NOTICES)
      save()
      return notice
    },
    // The window handed it to the voice.
    ack(id) {
      const before = items.length
      const acked = items.find(n => n.id === id)
      if (acked) heard = [...heard, { ...acked, ackedAt: clock() }].slice(-MAX_NOTICES)
      items = items.filter(n => n.id !== id)
      if (items.length !== before) save()
      return items.length !== before
    },
    pending: () => [...fresh()],
  }
}
