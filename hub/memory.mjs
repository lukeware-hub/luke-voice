// Ceci's memory: one SQLite file per machine (~/.ceci/memory.db), shared by every Claude session
// and every persona, outside luke-voice's own folder so an uninstall does not take it along.
// Every conversation is recorded whole: the user's and Ceci's words, the tools and tasks, and the
// sessions' activity. Nothing is ever removed on its own: no limit, no rotation, no backup copy.
// The only way out is deleteMemory(), asked for by the user.
//
// The hub is the only writer. Searching is full text (FTS5, accents ignored), and a ladder of
// summaries (conversation, day, month, life) keeps even the first conversation within reach.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// node:sqlite comes with Node 22.5+. Without it the memory still records (to pending.jsonl) and
// everything is moved into the database the first time a newer Node opens it.
let DatabaseSync = null
let sqliteError = ''
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch (error) {
  sqliteError = String(error?.message ?? error)
}

export const SCHEMA_VERSION = 2

export const KINDS = ['user', 'ceci', 'notice', 'tool_call', 'tool_result', 'task', 'task_result', 'session_prompt', 'session_tool', 'session_done', 'session_failure', 'session_info']

export function memoryDir() {
  return process.env.CECI_MEMORY_HOME || join(homedir(), '.ceci')
}

// Local calendar day and month of a time, as the user lives them.
export const dayOf = at => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const monthOf = at => dayOf(at).slice(0, 7)

// The exact local time of a moment, with seconds and the UTC offset: "2026-11-25T14:03:09-03:00".
export const stampOf = at => {
  const d = new Date(at)
  const p = n => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  return `${dayOf(at)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
}
const startOfDay = day => new Date(`${day}T00:00:00`).getTime()
const nextDay = day => {
  const d = new Date(`${day}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return d.getTime()
}
const startOfMonth = month => new Date(`${month}-01T00:00:00`).getTime()
const nextMonth = month => {
  const d = new Date(`${month}-01T00:00:00`)
  d.setMonth(d.getMonth() + 1)
  return d.getTime()
}

// A date the user or the brain gives ("2026-11-03", "2026-11", a time in ms) as [from, to).
export function rangeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return [value, value + 1]
  const text = String(value ?? '').trim()
  // A date and time ("2026-11-03T14:30" or "2026-11-03 14:30:05"): that minute, or that second.
  const moment = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/)
  if (moment) {
    const t = new Date(`${moment[1]}T${moment[2]}${moment[3] ?? ':00'}`).getTime()
    if (Number.isNaN(t)) return null
    return [t, t + (moment[3] ? 1000 : 60_000)]
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return [startOfDay(text), nextDay(text)]
  if (/^\d{4}-\d{2}$/.test(text)) return [startOfMonth(text), nextMonth(text)]
  return null
}

const plain = text =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

// Words that say nothing alone: a search for "o que a gente falou do deploy" looks for "deploy".
const STOP = new Set(
  'a o as os de da do das dos e em no na nos nas um uma uns umas que pra para por com sem se ao aos me te lhe eu tu ele ela nos vos eles elas voce voces isso isto aquilo esse essa este esta foi era ser ter tem tinha ja nao sim mais menos muito pouco como quando onde qual quais quem porque lembra lembro lembrar falou falamos falei falar conversa conversamos conversei gente ceci the and of to'.split(' '),
)

// The words of a search, as an FTS5 query: each word quoted (no FTS syntax gets through), any of them.
export function ftsQuery(text) {
  const words = [...new Set(plain(text).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !STOP.has(w)))].slice(0, 12)
  return words.length ? words.map(w => `"${w}"`).join(' OR ') : ''
}

// The scope of a delete the brain asked for (luke_memory_delete's args): exactly one of
// conversation, day (a day or a month), search or all. Null when it names nothing clear.
export function scopeFromArgs({ conversation, day, search, all } = {}) {
  if (all === true || all === 'true') return { all: true }
  const id = String(conversation ?? '').replace(/^#/, '')
  if (/^\d+$/.test(id)) return { conversation: Number(id) }
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(String(day ?? ''))) return { day: String(day) }
  if (String(search ?? '').trim()) return { search: String(search) }
  return null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'call',
  day TEXT NOT NULL,
  persona TEXT,
  voice TEXT,
  title TEXT
);
CREATE INDEX IF NOT EXISTS conversations_started ON conversations(started_at);
CREATE INDEX IF NOT EXISTS conversations_day ON conversations(kind, day);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  session TEXT,
  text TEXT NOT NULL,
  meta TEXT,
  untrusted INTEGER NOT NULL DEFAULT 0,
  at_text TEXT
);
CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id, id);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='events', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL,
  period TEXT NOT NULL,
  text TEXT NOT NULL,
  to_event INTEGER NOT NULL,
  made_at INTEGER NOT NULL,
  UNIQUE(level, period)
);
CREATE TABLE IF NOT EXISTS deletions (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  how TEXT NOT NULL,
  scope TEXT NOT NULL,
  count INTEGER NOT NULL
);
`

// How long a call may sit with no event before a new event starts a new conversation: a window
// closed without saying goodbye does not glue tomorrow's talk onto today's.
const CALL_GAP_MS = 30 * 60_000

export function openMemory({ dir = memoryDir(), now = Date.now, log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'memory.db')
  const pendingFile = join(dir, 'pending.jsonl')
  if (!DatabaseSync) {
    log(`memory: node:sqlite is not available (${sqliteError}); recording to ${pendingFile} until a newer Node opens it`)
    return pendingOnly({ dir, file, pendingFile, now, log })
  }
  const isNew = !existsSync(file)
  const db = new DatabaseSync(file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows has no Unix modes; the file is in the user's own profile.
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version < SCHEMA_VERSION) {
    // Migrations only add: a table, a column, an index. They never drop or rewrite what is there.
    db.exec(SCHEMA)
    // v2: every event also carries its exact local time as text. Older rows get it from their `at`.
    if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'at_text'").get()) db.exec('ALTER TABLE events ADD COLUMN at_text TEXT')
    const old = db.prepare('SELECT id, at FROM events WHERE at_text IS NULL').all()
    if (old.length) {
      const fill = db.prepare('UPDATE events SET at_text = ? WHERE id = ?')
      db.exec('BEGIN')
      for (const row of old) fill.run(stampOf(row.at), row.id)
      db.exec('COMMIT')
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  if (isNew) log(`memory: created ${file}`)

  const q = {
    insertConversation: db.prepare('INSERT INTO conversations (started_at, kind, day, persona, voice) VALUES (?, ?, ?, ?, ?)'),
    endConversation: db.prepare('UPDATE conversations SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
    conversationById: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    background: db.prepare("SELECT id FROM conversations WHERE kind = 'background' AND day = ? ORDER BY id DESC LIMIT 1"),
    lastEventAt: db.prepare('SELECT MAX(at) AS at FROM events WHERE conversation_id = ?'),
    insertEvent: db.prepare('INSERT INTO events (conversation_id, at, kind, session, text, meta, untrusted, at_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    callAt: db.prepare("SELECT id FROM conversations WHERE kind = 'call' AND started_at <= ? AND ended_at >= ? ORDER BY started_at DESC LIMIT 1"),
  }

  // The call being recorded now, or null between calls.
  let current = null

  function startCall({ persona = null, voice = null } = {}) {
    if (current) endCall(current)
    const at = now()
    current = Number(q.insertConversation.run(at, 'call', dayOf(at), persona, voice).lastInsertRowid)
    return current
  }

  function endCall(id = current) {
    if (!id) return
    q.endConversation.run(now(), id)
    if (id === current) current = null
  }

  // Where an event with no call goes: the call if one is open (and still alive), else the day's
  // background conversation (the sessions' activity while no one talks to Ceci).
  function conversationFor(at, wantsCall) {
    if (current) {
      const last = q.lastEventAt.get(current)?.at ?? q.conversationById.get(current)?.started_at ?? at
      if (at - last <= CALL_GAP_MS) return current
      // Gone quiet: it ended with its last word, not now.
      q.endConversation.run(last, current)
      current = null
    }
    if (wantsCall) {
      // Words said during a call that already closed (the window sends them in batches) belong to it.
      const late = q.callAt.get(at, at)
      if (late) return late.id
      current = Number(q.insertConversation.run(at, 'call', dayOf(at), null, null).lastInsertRowid)
      return current
    }
    const day = dayOf(at)
    const found = q.background.get(day)
    if (found) return found.id
    return Number(q.insertConversation.run(at, 'background', day, null, null).lastInsertRowid)
  }

  // Records one event. Never throws: an event that cannot be written goes to pending.jsonl and is
  // moved in on the next open, so nothing said is lost.
  function append({ kind, text, session = null, meta = null, untrusted = false, at = now(), conversation = null } = {}) {
    const body = String(text ?? '')
    if (!body.trim()) return null
    const k = KINDS.includes(kind) ? kind : 'session_info'
    try {
      const talk = k === 'user' || k === 'ceci' || k === 'notice'
      const id = conversation ?? conversationFor(at, talk)
      return Number(q.insertEvent.run(id, at, k, session, body, meta ? JSON.stringify(meta) : null, untrusted ? 1 : 0, stampOf(at)).lastInsertRowid)
    } catch (error) {
      log(`memory: could not record an event (${error?.message ?? error}); kept in ${pendingFile}`)
      try {
        appendFileSync(pendingFile, `${JSON.stringify({ kind: k, text: body, session, meta, untrusted, at })}\n`, { mode: 0o600 })
      } catch {
        // Nowhere to write at all (a full disk): the hub log above still says so.
      }
      return null
    }
  }

  // Events written while the database could not be opened or written, moved in now, in order.
  function replayPending() {
    if (!existsSync(pendingFile)) return 0
    const moving = `${pendingFile}.replaying`
    renameSync(pendingFile, moving)
    let count = 0
    // Talk close in time is one call again, as it was when it was said.
    let call = null
    let callAt = -Infinity
    db.exec('BEGIN')
    try {
      for (const line of readFileSync(moving, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          const talk = event.kind === 'user' || event.kind === 'ceci' || event.kind === 'notice'
          const day = dayOf(event.at)
          if (talk && (call === null || event.at - callAt > CALL_GAP_MS)) {
            call = Number(q.insertConversation.run(event.at, 'call', day, null, null).lastInsertRowid)
            q.endConversation.run(event.at, call)
          }
          if (talk) callAt = event.at
          const id = talk ? call : (q.background.get(day)?.id ?? Number(q.insertConversation.run(event.at, 'background', day, null, null).lastInsertRowid))
          q.insertEvent.run(id, event.at, event.kind, event.session ?? null, String(event.text), event.meta ? JSON.stringify(event.meta) : null, event.untrusted ? 1 : 0, stampOf(event.at))
          count++
        } catch {
          // A torn last line (the process died mid-write) is skipped.
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      renameSync(moving, pendingFile)
      throw error
    }
    unlinkSync(moving)
    if (count) log(`memory: moved ${count} pending events in`)
    return count
  }
  replayPending()

  const hitRow = row => ({ id: row.id, conversation: row.conversation_id, at: row.at, when: row.at_text ?? stampOf(row.at), day: dayOf(row.at), kind: row.kind, session: row.session, text: row.text, untrusted: Boolean(row.untrusted) })

  // Full-text search, best first: BM25, with a little weight for recent events.
  function search(query, { from = null, to = null, kind = null, limit = 10 } = {}) {
    const match = ftsQuery(query)
    if (!match) return []
    const where = ['events_fts MATCH ?']
    const args = [match]
    if (from !== null) where.push('e.at >= ?'), args.push(from)
    if (to !== null) where.push('e.at < ?'), args.push(to)
    if (kind) where.push('e.kind = ?'), args.push(kind)
    const rows = db
      .prepare(`SELECT e.*, bm25(events_fts) AS score FROM events_fts JOIN events e ON e.id = events_fts.rowid WHERE ${where.join(' AND ')} ORDER BY score LIMIT 200`)
      .all(...args)
    const newest = now()
    return rows
      .map(row => ({ row, rank: -row.score + 0.5 / (1 + (newest - row.at) / (30 * 86_400_000)) }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(({ row }) => hitRow(row))
  }

  const conversationRow = row =>
    row && {
      id: row.id,
      kind: row.kind,
      day: row.day,
      startedAt: row.started_at,
      startedAtText: stampOf(row.started_at),
      endedAt: row.ended_at,
      endedAtText: row.ended_at ? stampOf(row.ended_at) : null,
      persona: row.persona,
      voice: row.voice,
      title: row.title,
      summary: db.prepare("SELECT text FROM summaries WHERE level = 'conversation' AND period = ?").get(String(row.id))?.text ?? null,
      events: db.prepare('SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?').get(row.id).n,
    }

  // A conversation by id, "first", "last" or a date (its first conversation that day), with its
  // events, paged from the start.
  function conversation(which, { offset = 0, limit = 200, includeBackground = false } = {}) {
    const kinds = includeBackground ? "('call','background')" : "('call')"
    let row = null
    if (which === 'first') row = db.prepare(`SELECT * FROM conversations WHERE kind IN ${kinds} AND EXISTS (SELECT 1 FROM events WHERE conversation_id = conversations.id) ORDER BY started_at, id LIMIT 1`).get()
    else if (which === 'last') row = db.prepare(`SELECT * FROM conversations WHERE kind IN ${kinds} AND EXISTS (SELECT 1 FROM events WHERE conversation_id = conversations.id) ORDER BY started_at DESC, id DESC LIMIT 1`).get()
    else if (rangeOf(which) && typeof which === 'string') {
      const [from, to] = rangeOf(which)
      row = db.prepare(`SELECT * FROM conversations WHERE kind IN ${kinds} AND started_at >= ? AND started_at < ? AND EXISTS (SELECT 1 FROM events WHERE conversation_id = conversations.id) ORDER BY started_at, id LIMIT 1`).get(from, to)
    } else if (Number.isInteger(Number(which))) row = q.conversationById.get(Number(which))
    if (!row) return null
    const events = db.prepare('SELECT * FROM events WHERE conversation_id = ? ORDER BY id LIMIT ? OFFSET ?').all(row.id, Math.min(limit, 1000), Math.max(0, offset)).map(hitRow)
    return { ...conversationRow(row), offset, items: events }
  }

  // The conversations, newest first, a page at a time.
  function conversations({ before = null, limit = 30, includeBackground = false } = {}) {
    const kinds = includeBackground ? "('call','background')" : "('call')"
    const rows = db
      .prepare(`SELECT * FROM conversations WHERE kind IN ${kinds} AND EXISTS (SELECT 1 FROM events WHERE conversation_id = conversations.id) ${before ? 'AND started_at < ?' : ''} ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(...(before ? [before, Math.min(limit, 200)] : [Math.min(limit, 200)]))
    return rows.map(conversationRow)
  }

  // The day and month summaries in a period, oldest first; days not summarized yet are listed with
  // their conversation titles.
  function timeline({ from = null, to = null } = {}) {
    const lo = from ?? 0
    const hi = to ?? Number.MAX_SAFE_INTEGER
    const months = db.prepare("SELECT period, text FROM summaries WHERE level = 'month' ORDER BY period").all().filter(s => startOfMonth(s.period) < hi && nextMonth(s.period) > lo)
    const days = db.prepare("SELECT period, text FROM summaries WHERE level = 'day' ORDER BY period").all().filter(s => startOfDay(s.period) < hi && nextDay(s.period) > lo)
    const summarizedDays = new Set(days.map(d => d.period))
    const open = db
      .prepare("SELECT day, GROUP_CONCAT(COALESCE(title, ''), ' | ') AS titles, COUNT(*) AS n FROM conversations WHERE kind = 'call' AND started_at >= ? AND started_at < ? AND EXISTS (SELECT 1 FROM events WHERE conversation_id = conversations.id) GROUP BY day ORDER BY day")
      .all(lo, Math.min(hi, Number.MAX_SAFE_INTEGER))
      .filter(d => !summarizedDays.has(d.day))
      .map(d => ({ period: d.day, text: `${d.n} conversa(s)${d.titles.replace(/[ |]/g, '') ? `: ${d.titles}` : ''}` }))
    return { months, days: [...days, ...open].sort((a, b) => a.period.localeCompare(b.period)) }
  }

  const summaryOf = (level, period) => db.prepare('SELECT * FROM summaries WHERE level = ? AND period = ?').get(level, String(period)) ?? null

  // What the brain reads on every turn: the life summary, the last conversations and the best hits
  // for what the user just said.
  function digest(text = '', { hits = 5, recent = 5 } = {}) {
    const life = summaryOf('life', 'all')?.text ?? null
    const first = db.prepare("SELECT MIN(started_at) AS at FROM conversations WHERE kind = 'call' AND EXISTS (SELECT 1 FROM events WHERE conversation_id = conversations.id)").get()?.at ?? null
    const last = conversations({ limit: recent }).map(c => ({ id: c.id, day: c.day, title: c.title ?? c.summary ?? null }))
    const found = text ? search(text, { limit: hits }).filter(hit => hit.conversation !== current) : []
    return { life, firstDay: first ? dayOf(first) : null, recent: last, hits: found }
  }

  // ---- Summaries: what is missing, and saving what a model wrote ----

  const lastEventId = () => db.prepare('SELECT MAX(id) AS id FROM events').get()?.id ?? 0

  // The next summaries to write, oldest first: conversations that ended, past days, past months,
  // then the life summary when anything under it changed. Each item carries the text to sum up.
  function pendingSummaries({ max = 4 } = {}) {
    const items = []
    const nowAt = now()
    const today = dayOf(nowAt)
    const thisMonth = monthOf(nowAt)
    const transcript = id => {
      const rows = db.prepare('SELECT at, kind, session, text, untrusted FROM events WHERE conversation_id = ? ORDER BY id').all(id)
      const lines = rows.map(r => {
        const who = { user: 'usuário', ceci: 'ceci', notice: 'aviso' }[r.kind] ?? `${r.kind}${r.session ? ` ${r.session}` : ''}`
        return `${stampOf(r.at).slice(11, 19)} ${who}: ${r.text.replace(/\s+/g, ' ').slice(0, 600)}`
      })
      const all = lines.join('\n')
      // A long one: its start and its end, which say what it was about and how it ended.
      return all.length <= 14_000 ? all : `${all.slice(0, 7_000)}\n[...]\n${all.slice(-7_000)}`
    }
    // Conversations that ended (or went quiet) and have no summary, or one older than their events.
    const ended = db
      .prepare(
        `SELECT c.id, c.day, c.kind, (SELECT MAX(id) FROM events WHERE conversation_id = c.id) AS last, (SELECT MAX(at) FROM events WHERE conversation_id = c.id) AS lastAt, s.to_event AS done
         FROM conversations c LEFT JOIN summaries s ON s.level = 'conversation' AND s.period = CAST(c.id AS TEXT)
         WHERE EXISTS (SELECT 1 FROM events WHERE conversation_id = c.id) AND (s.to_event IS NULL OR s.to_event < (SELECT MAX(id) FROM events WHERE conversation_id = c.id))
         ORDER BY c.started_at LIMIT 50`,
      )
      .all()
      .filter(c => c.id !== current && (c.kind === 'call' ? true : c.day < today) && nowAt - c.lastAt > 60_000)
    for (const c of ended) {
      if (items.length >= max) return items
      items.push({ level: 'conversation', period: String(c.id), toEvent: c.last, day: c.day, text: transcript(c.id) })
    }
    // Past days whose conversations all have their summaries.
    const days = db
      .prepare(
        `SELECT c.day, MAX(e.id) AS last FROM conversations c JOIN events e ON e.conversation_id = c.id WHERE c.day < ? GROUP BY c.day ORDER BY c.day`,
      )
      .all(today)
    for (const d of days) {
      if (items.length >= max) return items
      const done = summaryOf('day', d.day)
      if (done && done.to_event >= d.last) continue
      const parts = db
        .prepare("SELECT c.id, c.kind, c.title, s.text FROM conversations c JOIN summaries s ON s.level = 'conversation' AND s.period = CAST(c.id AS TEXT) WHERE c.day = ? AND EXISTS (SELECT 1 FROM events WHERE conversation_id = c.id) ORDER BY c.started_at")
        .all(d.day)
      const all = db.prepare('SELECT COUNT(*) AS n FROM conversations c WHERE c.day = ? AND EXISTS (SELECT 1 FROM events WHERE conversation_id = c.id)').get(d.day).n
      if (parts.length < all) continue
      items.push({ level: 'day', period: d.day, toEvent: d.last, text: parts.map(p => `- ${p.kind === 'background' ? '(atividade das sessões) ' : ''}${p.title ? `${p.title}: ` : ''}${p.text}`).join('\n') })
    }
    // Past months whose days all have their summaries.
    const months = [...new Set(days.map(d => d.day.slice(0, 7)))].filter(m => m < thisMonth)
    for (const month of months) {
      if (items.length >= max) return items
      const inMonth = days.filter(d => d.day.startsWith(month))
      const last = Math.max(...inMonth.map(d => d.last))
      const done = summaryOf('month', month)
      if (done && done.to_event >= last) continue
      const parts = inMonth.map(d => summaryOf('day', d.day))
      if (parts.some(p => !p || p.to_event < inMonth.find(d => d.day === p.period).last)) continue
      items.push({ level: 'month', period: month, toEvent: last, text: parts.map(p => `- ${p.period}: ${p.text}`).join('\n') })
    }
    // The life summary: past months, then this month's days, then today's conversations.
    const life = summaryOf('life', 'all')
    const newest = db.prepare("SELECT MAX(made_at) AS at FROM summaries WHERE level <> 'life'").get()?.at ?? 0
    if (items.length < max && newest && (!life || life.made_at < newest)) {
      const lines = [
        ...db.prepare("SELECT period, text FROM summaries WHERE level = 'month' ORDER BY period").all().map(s => `- ${s.period}: ${s.text}`),
        ...db.prepare("SELECT period, text FROM summaries WHERE level = 'day' AND period >= ? ORDER BY period").all(`${thisMonth}-01`).map(s => `- ${s.period}: ${s.text}`),
        ...db
          .prepare("SELECT c.day, s.text FROM conversations c JOIN summaries s ON s.level = 'conversation' AND s.period = CAST(c.id AS TEXT) WHERE c.day >= ? AND c.day NOT IN (SELECT period FROM summaries WHERE level = 'day') ORDER BY c.started_at")
          .all(`${thisMonth}-01`)
          .map(s => `- ${s.day}: ${s.text}`),
      ]
      if (lines.length) items.push({ level: 'life', period: 'all', toEvent: lastEventId(), text: lines.join('\n').slice(-40_000) })
    }
    return items
  }

  // Saves a summary a model wrote for one of pendingSummaries()'s items. A conversation summary may
  // bring its title. An item whose events were deleted meanwhile is dropped.
  function saveSummary({ level, period, toEvent, text, title = null }) {
    if (!['conversation', 'day', 'month', 'life'].includes(level) || !String(text ?? '').trim()) return false
    if (level === 'conversation') {
      const exists = db.prepare('SELECT MAX(id) AS last FROM events WHERE conversation_id = ?').get(Number(period))?.last
      if (!exists || exists < toEvent) return false
      if (title) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(String(title).slice(0, 120), Number(period))
    }
    db.prepare('INSERT INTO summaries (level, period, text, to_event, made_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(level, period) DO UPDATE SET text = excluded.text, to_event = excluded.to_event, made_at = excluded.made_at').run(
      level,
      String(period),
      String(text).trim().slice(0, level === 'life' ? 3000 : 2000),
      toEvent,
      now(),
    )
    return true
  }

  // ---- Delete: the only way anything leaves ----

  // The events a scope covers: { all }, { conversation }, { event }, { from, to } or { day },
  // { search }. Never empty-by-mistake: an unknown scope covers nothing.
  function scopeWhere(scope = {}) {
    if (scope.all === true) return ['1 = 1', []]
    if (scope.conversation !== undefined) return ['conversation_id = ?', [Number(scope.conversation)]]
    if (scope.event !== undefined) return ['id = ?', [Number(scope.event)]]
    if (scope.day !== undefined) {
      const range = rangeOf(scope.day)
      if (!range) return ['0 = 1', []]
      return ['at >= ? AND at < ?', range]
    }
    if (scope.from !== undefined || scope.to !== undefined) {
      const from = rangeOf(scope.from)?.[0] ?? Number(scope.from ?? 0)
      const to = rangeOf(scope.to)?.[1] ?? Number(scope.to ?? Number.MAX_SAFE_INTEGER)
      if (!Number.isFinite(from) || !Number.isFinite(to)) return ['0 = 1', []]
      return ['at >= ? AND at < ?', [from, to]]
    }
    if (scope.search !== undefined) {
      const match = ftsQuery(scope.search)
      if (!match) return ['0 = 1', []]
      return ['id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)', [match]]
    }
    return ['0 = 1', []]
  }

  // What a delete would remove, to tell the user before asking.
  function preview(scope) {
    const [where, args] = scopeWhere(scope)
    const row = db.prepare(`SELECT COUNT(*) AS events, COUNT(DISTINCT conversation_id) AS conversations, MIN(at) AS first, MAX(at) AS last FROM events WHERE ${where}`).get(...args)
    return { events: row.events, conversations: row.conversations, firstDay: row.first ? dayOf(row.first) : null, lastDay: row.last ? dayOf(row.last) : null }
  }

  // Deletes for good: the events, their index entries, every summary that covered them (rebuilt
  // later from what is left), the conversations left empty. Then the file is compacted so the
  // bytes are gone from the disk too.
  function deleteMemory(scope, { how = 'command' } = {}) {
    const [where, args] = scopeWhere(scope)
    db.exec('BEGIN')
    let count = 0
    try {
      const touched = db.prepare(`SELECT DISTINCT conversation_id AS id, (SELECT day FROM conversations WHERE id = conversation_id) AS day FROM events WHERE ${where}`).all(...args)
      count = Number(db.prepare(`DELETE FROM events WHERE ${where}`).run(...args).changes)
      const days = new Set(touched.map(t => t.day))
      for (const t of touched) db.prepare("DELETE FROM summaries WHERE level = 'conversation' AND period = ?").run(String(t.id))
      for (const day of days) {
        db.prepare("DELETE FROM summaries WHERE level = 'day' AND period = ?").run(day)
        db.prepare("DELETE FROM summaries WHERE level = 'month' AND period = ?").run(day.slice(0, 7))
      }
      if (count) db.prepare("DELETE FROM summaries WHERE level = 'life'").run()
      // Conversations with nothing left go too (titles are made from their words).
      db.prepare('DELETE FROM conversations WHERE NOT EXISTS (SELECT 1 FROM events WHERE conversation_id = conversations.id) AND id <> ?').run(current ?? -1)
      if (scope.all === true) db.prepare('DELETE FROM summaries').run()
      db.prepare('INSERT INTO deletions (at, how, scope, count) VALUES (?, ?, ?, ?)').run(now(), String(how).slice(0, 20), JSON.stringify(scope).slice(0, 300), count)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    if (scope.all === true && current) current = null
    // Merge the index segments (deleted words leave the index), then rewrite the file.
    db.exec("INSERT INTO events_fts(events_fts) VALUES ('optimize')")
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    log(`memory: deleted ${count} events (${how})`)
    return { deleted: count }
  }

  function stats() {
    const row = db.prepare("SELECT COUNT(*) AS events, MIN(at) AS first, MAX(at) AS last FROM events").get()
    const calls = db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'call' AND EXISTS (SELECT 1 FROM events WHERE conversation_id = conversations.id)").get().n
    let bytes = 0
    try {
      bytes = statSync(file).size + (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0)
    } catch {
      // Size is only informative.
    }
    return { file, bytes, events: row.events, conversations: calls, firstDay: row.first ? dayOf(row.first) : null, lastDay: row.last ? dayOf(row.last) : null, isAvailable: true }
  }

  return {
    file,
    isAvailable: true,
    get current() {
      return current
    },
    startCall,
    endCall,
    append,
    replayPending,
    search,
    conversation,
    conversations,
    timeline,
    digest,
    pendingSummaries,
    saveSummary,
    preview,
    deleteMemory,
    stats,
    close: () => db.close(),
  }
}

// No node:sqlite: events still go to pending.jsonl (nothing is lost); reading finds nothing yet.
function pendingOnly({ file, pendingFile, now, log }) {
  const append = ({ kind, text, session = null, meta = null, untrusted = false, at = now() } = {}) => {
    if (!String(text ?? '').trim()) return null
    try {
      appendFileSync(pendingFile, `${JSON.stringify({ kind, text: String(text), session, meta, untrusted, at })}\n`, { mode: 0o600 })
    } catch (error) {
      log(`memory: could not record an event (${error?.message ?? error})`)
    }
    return null
  }
  const none = () => null
  return {
    file,
    isAvailable: false,
    current: null,
    startCall: none,
    endCall: none,
    append,
    replayPending: () => 0,
    search: () => [],
    conversation: none,
    conversations: () => [],
    timeline: () => ({ months: [], days: [] }),
    digest: () => ({ life: null, firstDay: null, recent: [], hits: [] }),
    pendingSummaries: () => [],
    saveSummary: () => false,
    preview: () => ({ events: 0, conversations: 0, firstDay: null, lastDay: null }),
    // The pending journal holds everything recorded so far: deleting "all" removes it.
    deleteMemory: scope => {
      if (scope?.all !== true || !existsSync(pendingFile)) return { deleted: 0 }
      const lines = readFileSync(pendingFile, 'utf8').split('\n').filter(Boolean).length
      unlinkSync(pendingFile)
      return { deleted: lines }
    },
    stats: () => ({ file, bytes: 0, events: 0, conversations: 0, firstDay: null, lastDay: null, isAvailable: false }),
    close: () => {},
  }
}
