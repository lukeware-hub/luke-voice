// Keeps the user's ElevenLabs voice agent in step with agent/agent.json and agent/prompt.md.
// Plain REST, no SDK, so an install needs no packages.
import { createHash, randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ASR_TERMS } from './engine.mjs'
import { stateFile } from './paths.mjs'

const API = 'https://api.elevenlabs.io/v1'
// An ElevenLabs request past this fails, instead of holding a call (or the agent sync) forever.
const REQUEST_TIMEOUT_MS = 20_000

export async function readDefinition(root) {
  const def = JSON.parse(await readFile(join(root, 'agent', 'agent.json'), 'utf8'))
  const prompt = await readFile(join(root, 'agent', 'prompt.md'), 'utf8')
  const hash = createHash('sha256').update(JSON.stringify(def)).update(prompt).update(ASR_TERMS.join(',')).digest('hex').slice(0, 16)
  return { def, prompt, hash }
}

async function call(apiKey, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    const error = new Error(`ElevenLabs ${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
    error.status = res.status
    throw error
  }
  return text ? JSON.parse(text) : {}
}

// Client tools are their own resources: find each by name, update it, or create it.
async function upsertTools(apiKey, tools) {
  const listed = await call(apiKey, 'GET', '/convai/tools')
  const byName = new Map((listed.tools ?? []).map(tool => [tool.tool_config?.name, tool.id]))
  const ids = []
  for (const config of tools) {
    const id = byName.get(config.name)
    const saved = id
      ? await call(apiKey, 'PATCH', `/convai/tools/${id}`, { tool_config: config })
      : await call(apiKey, 'POST', '/convai/tools', { tool_config: config })
    ids.push(saved.id ?? id)
  }
  return ids
}

// A voice from the ElevenLabs library must be in the account before an agent can use it.
// Returns the id the account knows it by: the library id, or the id it got when added.
export async function ensureVoice(apiKey, voice, request = call) {
  if (!voice?.voice_id || !voice.public_owner_id) return voice?.voice_id
  const listed = await request(apiKey, 'GET', `/voices?search=${encodeURIComponent(voice.name)}`).catch(() => ({ voices: [] }))
  const mine = (listed.voices ?? []).find(v => v.voice_id === voice.voice_id || v.sharing?.original_voice_id === voice.voice_id || v.name === voice.name)
  if (mine) return mine.voice_id
  const added = await request(apiKey, 'POST', `/voices/add/${voice.public_owner_id}/${voice.voice_id}`, { new_name: voice.name })
  return added.voice_id ?? voice.voice_id
}

export function agentBody(def, prompt, toolIds, voiceId) {
  const { tools: _tools, library_voice: _voice, ...rest } = def
  const config = structuredClone(rest.conversation_config)
  config.agent.prompt = { ...config.agent.prompt, prompt, tool_ids: toolIds }
  if (voiceId) config.tts = { ...config.tts, voice_id: voiceId }
  // The terms Ceci's own ears are told (engine.mjs), so ElevenLabs hears them right too.
  config.asr = { ...config.asr, keywords: ASR_TERMS }
  return { ...rest, conversation_config: config }
}

async function findByName(apiKey, name) {
  const listed = await call(apiKey, 'GET', `/convai/agents?search=${encodeURIComponent(name)}&page_size=100`)
  return (listed.agents ?? []).find(agent => agent.name === name)?.agent_id ?? null
}

async function exists(apiKey, id) {
  try {
    await call(apiKey, 'GET', `/convai/agents/${id}`)
    return true
  } catch (error) {
    if (error.status === 404 || error.status === 400) return false
    throw error
  }
}

// Syncs in progress, by key and root: two /token requests at once (a double click, two windows)
// share one, instead of each creating the agent and its tools. A failed one is forgotten, so the
// next request tries again.
const syncing = new Map()

// Returns the agent id, syncing the agent first when the definition changed or the agent is gone.
export function ensureAgent(apiKey, root, options = {}) {
  if (process.env.LUKE_VOICE_AGENT_ID) return Promise.resolve(process.env.LUKE_VOICE_AGENT_ID)
  const at = `${apiKey}\n${root}`
  if (!syncing.has(at)) syncing.set(at, syncAgent(apiKey, root, options).finally(() => syncing.delete(at)))
  return syncing.get(at)
}

async function syncAgent(apiKey, root, { log = () => {} } = {}) {
  const { def, prompt, hash } = await readDefinition(root)
  const file = stateFile('agent.json')
  // A missing, truncated or broken file only means the agent is looked up again.
  const saved = await readFile(file, 'utf8').then(
    text => {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    },
    () => null,
  )

  if (saved?.id && saved.hash === hash && (await exists(apiKey, saved.id))) return saved.id

  const toolIds = await upsertTools(apiKey, def.tools ?? [])
  const voiceId = await ensureVoice(apiKey, def.library_voice)
  const body = agentBody(def, prompt, toolIds, voiceId)
  let id = saved?.id && (await exists(apiKey, saved.id)) ? saved.id : await findByName(apiKey, def.name)

  if (id) {
    await call(apiKey, 'PATCH', `/convai/agents/${id}`, body)
    log(`updated agent ${id}`)
  } else {
    id = (await call(apiKey, 'POST', '/convai/agents/create', body)).agent_id
    log(`created agent ${id}`)
  }

  // Written whole or not at all (a temp file, then rename): a hub killed mid-write leaves no
  // truncated file behind.
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, JSON.stringify({ id, hash }, null, 2), { mode: 0o600 })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
  return id
}

// The account's credits for the month: { used, limit, resetAt } or null when the key may not read it.
export async function credits(apiKey, request = call) {
  try {
    const sub = await request(apiKey, 'GET', '/user/subscription')
    if (typeof sub.character_count !== 'number' || typeof sub.character_limit !== 'number') return null
    const reset = Number(sub.next_character_count_reset_unix)
    return { used: sub.character_count, limit: sub.character_limit, resetAt: reset > 0 ? reset * 1000 : null }
  } catch {
    return null
  }
}

// What the user reads when the month's credits are gone, in their language.
export function outOfCreditsMessage({ used, limit, resetAt }) {
  const when = resetAt
    ? ` Eles voltam em ${new Date(resetAt).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}.`
    : ''
  return `Os créditos da ElevenLabs deste mês acabaram (${used.toLocaleString('pt-BR')} de ${limit.toLocaleString('pt-BR')}). Sem créditos, a ElevenLabs não inicia a chamada.${when} Para falar antes disso, assine um plano em elevenlabs.io/pricing.`
}

export async function conversationToken(apiKey, agentId) {
  const { token } = await call(apiKey, 'GET', `/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`)
  return token
}
