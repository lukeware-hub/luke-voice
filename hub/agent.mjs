// Keeps the user's ElevenLabs voice agent in step with agent/agent.json and agent/prompt.md.
// Plain REST, no SDK, so an install needs no packages.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { stateFile } from './paths.mjs'

const API = 'https://api.elevenlabs.io/v1'

export async function readDefinition(root) {
  const def = JSON.parse(await readFile(join(root, 'agent', 'agent.json'), 'utf8'))
  const prompt = await readFile(join(root, 'agent', 'prompt.md'), 'utf8')
  const hash = createHash('sha256').update(JSON.stringify(def)).update(prompt).digest('hex').slice(0, 16)
  return { def, prompt, hash }
}

async function call(apiKey, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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

function agentBody(def, prompt, toolIds) {
  const { tools: _tools, ...rest } = def
  const config = structuredClone(rest.conversation_config)
  config.agent.prompt = { ...config.agent.prompt, prompt, tool_ids: toolIds }
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

// Returns the agent id, syncing the agent first when the definition changed or the agent is gone.
export async function ensureAgent(apiKey, root, { log = () => {} } = {}) {
  if (process.env.LUKE_VOICE_AGENT_ID) return process.env.LUKE_VOICE_AGENT_ID

  const { def, prompt, hash } = await readDefinition(root)
  const file = stateFile('agent.json')
  const saved = await readFile(file, 'utf8').then(JSON.parse, () => null)

  if (saved?.id && saved.hash === hash && (await exists(apiKey, saved.id))) return saved.id

  const toolIds = await upsertTools(apiKey, def.tools ?? [])
  const body = agentBody(def, prompt, toolIds)
  let id = saved?.id && (await exists(apiKey, saved.id)) ? saved.id : await findByName(apiKey, def.name)

  if (id) {
    await call(apiKey, 'PATCH', `/convai/agents/${id}`, body)
    log(`updated agent ${id}`)
  } else {
    id = (await call(apiKey, 'POST', '/convai/agents/create', body)).agent_id
    log(`created agent ${id}`)
  }

  await writeFile(file, JSON.stringify({ id, hash }, null, 2), { mode: 0o600 })
  return id
}

export async function conversationToken(apiKey, agentId) {
  const { token } = await call(apiKey, 'GET', `/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`)
  return token
}
