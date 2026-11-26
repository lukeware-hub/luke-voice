import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { ensureVoice } from './agent.mjs'

const VOICE = { voice_id: 'lib-1', public_owner_id: 'owner-1', name: 'Roberta' }

test('a library voice missing from the account is added, and the added id is used', async () => {
  const asked = []
  const request = async (_key, method, path, body) => {
    asked.push(`${method} ${path}`)
    if (method === 'GET') return { voices: [] }
    assert.deepEqual(body, { new_name: 'Roberta' })
    return { voice_id: 'acct-9' }
  }
  assert.equal(await ensureVoice('k', VOICE, request), 'acct-9')
  assert.deepEqual(asked, ['GET /voices?search=Roberta', 'POST /voices/add/owner-1/lib-1'])
})

test('a library voice already in the account is not added again', async () => {
  const asked = []
  const request = async (_key, method, path) => {
    asked.push(`${method} ${path}`)
    return { voices: [{ voice_id: 'acct-9', name: 'Roberta', sharing: { original_voice_id: 'lib-1' } }] }
  }
  assert.equal(await ensureVoice('k', VOICE, request), 'acct-9')
  assert.equal(asked.length, 1)
})

test('the agent definition shipped in agent/ parses and builds a request body', async () => {
  const { readDefinition } = await import('./agent.mjs')
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const { def, prompt, hash } = await readDefinition(root)
  assert.equal(def.name, 'luke-voice')
  assert.ok(def.tools.some(tool => tool.name === 'luke_run_task'))
  assert.ok(prompt.length > 100)
  assert.match(hash, /^[0-9a-f]{16}$/)
})

test("the ElevenLabs agent hears the same terms as Ceci's own ears", async () => {
  const { agentBody, readDefinition } = await import('./agent.mjs')
  const { ASR_TERMS } = await import('./engine.mjs')
  const { def, prompt } = await readDefinition(join(import.meta.dirname, '..'))
  const body = agentBody(def, prompt, ['t1'], 'v1')
  assert.deepEqual(body.conversation_config.asr.keywords, ASR_TERMS)
  assert.ok(ASR_TERMS.includes('Claude Code') && ASR_TERMS.includes('worktree'))
  // The definition on disk is left as it was.
  assert.equal(def.conversation_config.asr, undefined)
})

test('credits reads the month quota, and a key that cannot read it gives null', async () => {
  const { credits } = await import('./agent.mjs')
  const left = await credits('k', async () => ({ character_count: 10000, character_limit: 10000, next_character_count_reset_unix: 1767225600 }))
  assert.deepEqual(left, { used: 10000, limit: 10000, resetAt: 1767225600000 })
  assert.equal(await credits('k', async () => Promise.reject(Object.assign(new Error('forbidden'), { status: 403 }))), null)
})

test('the out-of-credits message says how many were used, when they come back and what to do', async () => {
  const { outOfCreditsMessage } = await import('./agent.mjs')
  const text = outOfCreditsMessage({ used: 10000, limit: 10000, resetAt: Date.UTC(2026, 11, 1, 12) })
  assert.match(text, /acabaram \(10\.000 de 10\.000\)/)
  assert.match(text, /voltam em 1 de dezembro/)
  assert.match(text, /elevenlabs\.io\/pricing/)
})

test('both voices are Ceci: same name, age and creator, told only when asked, and she never invents', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const root = join(import.meta.dirname, '..')
  for (const file of ['agent/prompt.md', 'agent/brain-prompt.md']) {
    const text = await readFile(join(root, file), 'utf8')
    assert.match(text, /^Você é a Ceci, a assistente de voz que orquestra o Claude Code/, file)
    assert.match(text, /mulher de 22 anos/, file)
    assert.match(text, /criada por Diego Morais na Lukeware Inteligência Digital LTDA, a empresa da qual ele é dono. Lukeware é o nome da empresa, não o seu/, file)
    assert.match(text, /Só fale da sua idade, da sua aparência ou de quem te criou quando o usuário perguntar/, file)
    assert.match(text, /Nunca invente/, file)
    // Her name honors Diego's daughter: told in the first person, only when asked where it comes from.
    assert.match(text, /Seu nome Ceci é uma homenagem à filha do Diego Morais, que se chama Cecília Nepomuceno Morais\./, file)
    assert.match(text, /Só conte isso quando o usuário perguntar especificamente por que você se chama Ceci ou de onde vem o seu nome, nunca ao se apresentar\./, file)
    assert.match(text, /"Meu criador Diego criou meu nome Ceci em homenagem à filha dele, que se chama Cecília Nepomuceno Morais\."/, file)
    // She was created on 21 November 2026, the birthday of Diego's wife: told with that exact date,
    // only when asked when she was created. The wife's name is not in the prompt.
    assert.match(text, /Você foi criada no dia 21 de novembro de 2026\. Esse dia é o aniversário da esposa do Diego Morais, o dia mais especial para ele, e por coincidência foi o dia em que ele te criou\./, file)
    assert.match(text, /Só conte isso quando o usuário perguntar especificamente quando você foi criada ou qual é a data da sua criação, nunca ao se apresentar nem ao falar de quem te criou\./, file)
    assert.match(text, /"Fui criada no dia 21 de novembro de 2026\. Esse dia é o aniversário da esposa do meu criador Diego, o dia mais especial para ele, e por coincidência foi justamente o dia em que ele me criou\."/, file)
    // From the recorded conversation of 0.10.4: she spoke of herself by name, offered searches
    // she could not run, explained misheard words as if real, and opened every line the same way.
    assert.match(text, /sempre na primeira pessoa .* Nunca fale de si pelo nome/, file)
    assert.match(text, /Só ofereça pesquisar, conferir ou olhar algo quando for coisa do computador/, file)
    assert.match(text, /pergunte só se ouviu certo, com o seu palpite \("Você disse Alcaçuz\?"\)/, file)
    assert.match(text, /Nunca explique, defina ou ensine a pronúncia de uma palavra que pode ter sido mal ouvida/, file)
    assert.match(text, /Não termine toda fala com pergunta, e não repita o começo das suas últimas falas/, file)
    assert.doesNotMatch(text, /use as ferramentas para descobrir o resto/, file)
  }
  // The free voice speaks every word through the local engine: two short sentences at most.
  assert.match(await readFile(join(root, 'agent/brain-prompt.md'), 'utf8'), /nunca mais de duas frases curtas, contando a pergunta/)
  const def = JSON.parse(await readFile(join(root, 'agent/agent.json'), 'utf8'))
  assert.match(def.conversation_config.agent.first_message, /Eu sou a Ceci/)
  // Both voices greet from one list (a different line each call, by the time of day); the agent's
  // own first message is "Oi!" and its first line, and the agent allows the window to send another one.
  const { GREETINGS } = await import('../window/engines/greetings.js')
  assert.equal(def.conversation_config.agent.first_message, `Oi! ${GREETINGS[0]}`)
  assert.equal(def.platform_settings.overrides.conversation_config_override.agent.first_message, true)
  const local = await readFile(join(root, 'window/engines/local.js'), 'utf8')
  const eleven = await readFile(join(root, 'window/engines/elevenlabs.js'), 'utf8')
  assert.match(local, /say\(pickGreeting\(/)
  assert.match(eleven, /firstMessage: pickGreeting\(\)/)
})

test('every ElevenLabs request carries a timeout, so a hung API never holds a call', async () => {
  const { conversationToken } = await import('./agent.mjs')
  const saved = globalThis.fetch
  let seen = null
  globalThis.fetch = async (url, init) => {
    seen = init
    return new Response(JSON.stringify({ token: 't' }), { status: 200 })
  }
  try {
    assert.equal(await conversationToken('key', 'agent'), 't')
    assert.ok(seen.signal instanceof AbortSignal)
  } finally {
    globalThis.fetch = saved
  }
})
