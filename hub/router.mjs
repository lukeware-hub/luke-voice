// The instant layer of the hybrid brain (gpu profile). A small local model (Qwen3.5 0.8B on the
// CPU, run by the engine's router server) only sorts what the user said into a few kinds of small
// talk; the words Ceci says back are written here, so the router can never invent a fact or act.
// Anything that is not plainly small talk goes to Claude, as before.

// What the router may answer. "claude" means: not small talk, ask the real brain.
export const INTENTS = ['greeting', 'how_are_you', 'thanks', 'goodbye', 'identity', 'age', 'creator', 'ack', 'claude']

export const ROUTER_SYSTEM = `Classifique a fala do usuário para uma assistente de voz chamada Ceci, que controla o Claude Code. Responda só com o JSON {"intent": "..."}.
Intenções:
- greeting: só um cumprimento ("oi", "bom dia", "olá ceci").
- how_are_you: só pergunta como a Ceci está ("tudo bem?", "beleza?", "como você está?").
- thanks: só um agradecimento ("obrigado", "valeu").
- goodbye: só uma despedida ("tchau", "até mais", "por hoje é só").
- identity: pergunta quem a Ceci é, o nome dela ou o que ela faz.
- age: pergunta a idade da Ceci.
- creator: pergunta quem criou ou fez a Ceci.
- ack: só uma reação curta, sem pedido ("tá bom", "entendi", "legal", "que bom").
- claude: qualquer outra coisa. Todo pedido, pergunta sobre o projeto, código, testes, sessões, tarefas, horas, arquivos, o Claude, ou uma fala que junta cumprimento com pedido. Na dúvida, claude.`

const EXAMPLES = [
  ['oi ceci', 'greeting'],
  ['tudo bem com você?', 'how_are_you'],
  ['beleza, ceci?', 'how_are_you'],
  ['oi, como vai?', 'how_are_you'],
  ['brigada', 'thanks'],
  ['valeu!', 'thanks'],
  ['até mais', 'goodbye'],
  ['qual é o seu nome?', 'identity'],
  ['quantos anos você tem?', 'age'],
  ['quem te criou?', 'creator'],
  ['entendi', 'ack'],
  ['hum', 'claude'],
  ['manda o claude esperar', 'claude'],
  ['roda os testes', 'claude'],
  ['bom dia, como está o build?', 'claude'],
  ['obrigado, agora faz o commit', 'claude'],
  ['o que o claude está fazendo?', 'claude'],
]

// Small talk is short: a longer utterance goes straight to Claude, without asking the router.
export const MAX_ROUTED_WORDS = 8

const SCHEMA = { type: 'object', properties: { intent: { type: 'string', enum: INTENTS } }, required: ['intent'] }

// The chat request for llama-server: few-shot, no thinking, greedy, constrained to the schema.
export function routerBody(text) {
  const messages = [{ role: 'system', content: ROUTER_SYSTEM }]
  for (const [say, intent] of EXAMPLES) {
    messages.push({ role: 'user', content: say }, { role: 'assistant', content: JSON.stringify({ intent }) })
  }
  messages.push({ role: 'user', content: String(text ?? '').slice(0, 300) })
  return {
    messages,
    max_tokens: 16,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'route', schema: SCHEMA } },
  }
}

// The intent in a llama-server chat answer; "claude" for anything unexpected.
export function routeOf(answer) {
  try {
    const { intent } = JSON.parse(answer?.choices?.[0]?.message?.content ?? '')
    return INTENTS.includes(intent) ? intent : 'claude'
  } catch {
    return 'claude'
  }
}

// What Ceci says per intent: a few lines each, taken in turn so she does not repeat herself.
export const REPLIES = {
  greeting: ['Oi! Que bom te ouvir. O que vamos fazer?', 'Oi, oi! Estou aqui, pode falar.', 'Olá! Pronta para ajudar.'],
  how_are_you: ['Estou ótima, obrigada! E você, o que vamos fazer hoje?', 'Tudo ótimo por aqui! Em que posso ajudar?', 'Estou bem, e animada para trabalhar! O que você precisa?'],
  thanks: ['Imagina! Fico feliz em ajudar.', 'De nada! Qualquer coisa, é só chamar.', 'Por nada! Estou aqui.'],
  goodbye: ['Tchau! Até a próxima.', 'Até mais! Foi ótimo trabalhar com você.', 'Tchau, tchau! Qualquer coisa, me chama.'],
  identity: ['Eu sou a Ceci! Converso com você e cuido do Claude Code por voz: peço tarefas, acompanho as sessões e te conto o que aconteceu.'],
  age: ['Eu tenho 22 anos!'],
  creator: ['Quem me criou foi o Diego Morais, na Lukeware Inteligência Digital.'],
  ack: ['Combinado!', 'Certo!', 'Beleza!'],
}

const plain = text =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

// A second check, by words, on what the small model said: the reply is used only when the
// utterance has the words of that kind of small talk and none of a request. A wrong guess of the
// router then costs a Claude call, never a wrong answer.
const MUST = {
  greeting: /\b(oi+|ola|bom dia|boa tarde|boa noite|e ai|eai|opa|hey|alo)\b/,
  how_are_you: /\b(tudo (bem|bom|certo|joia|tranquilo|ok)|beleza|como (voce |ce |tu )?(esta|ta|vai|anda)|ta bem|de boa)\b/,
  thanks: /\b(obrigad\w*|valeu|brigad\w*|agradec\w*)\b/,
  goodbye: /\b(tchau|ate (mais|logo|amanha|a proxima|depois|breve)|falou|por hoje e so|boa noite)\b/,
  identity: /\b(quem e voce|qual (e )?(o )?(seu|teu) nome|quem (voce|ce) e|seu nome|teu nome|o que voce faz|voce e (um|uma)|se chama)\b/,
  age: /\b(qual (e )?a (sua|tua) idade|quantos anos|sua idade|tua idade|idade)\b/,
  creator: /\b(quem (te |a )?(criou|fez|desenvolveu|programou)|seu criador|te criou|fez voce|criou voce)\b/,
  ack: /^\W*((ta|esta) bom|entendi|legal|que bom|certo|beleza|ok|show|perfeito|otimo|massa|joia|bacana|uhum|ah|sim|ah ta|ta)(\W+(ta|bom|entendi|legal|que|certo|beleza|ok|show|perfeito|otimo|entao|ah|sim))*\W*$/,
}
// Words of a request, a question about the work, or Claude: never small talk.
const WORK = /\b(claude|sess\w*|test\w*|commit\w*|build|deploy\w*|arquiv\w*|projet\w*|tarefa\w*|codigo\w*|erro\w*|bug\w*|rod\w*|faz|faca|fazer|abr\w*|mand\w*|para|pare|parar|cancel\w*|cri[ae]\w*|mud\w*|lista\w*|termin\w*|hora\w*|quando|quanto\w*|qual|onde|porque|por que|agora|status|resultado|aconteceu|novidade\w*|ficou|deu)\b/

export function confirmed(intent, text) {
  const t = plain(text)
  if (!MUST[intent]?.test(t)) return false
  // The small-talk words themselves may look like work ("o que você faz?", "quem te criou?"):
  // the rest of the utterance must have none.
  return !WORK.test(t.replace(MUST[intent], ' '))
}

const turn = new Map()

// The line for an intent, or null when the intent needs Claude.
export function replyFor(intent) {
  const lines = REPLIES[intent]
  if (!lines) return null
  const at = turn.get(intent) ?? 0
  turn.set(intent, at + 1)
  return lines[at % lines.length]
}

const words = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length

// Routes one utterance. `ask(body)` posts the chat request and returns the parsed answer; it is
// skipped for long utterances. `lastSaid` is what Ceci said last: after a question of hers, a short
// reaction ("tá bom") is an answer, so it goes to Claude.
export async function route(text, { ask, lastSaid = '' }) {
  if (!text || words(text) > MAX_ROUTED_WORDS) return { intent: 'claude', say: null }
  let intent = 'claude'
  try {
    intent = routeOf(await ask(routerBody(text)))
  } catch {
    intent = 'claude'
  }
  // "tudo certo?" read as a greeting, or "oi" as a reaction: the words decide between them.
  if (['greeting', 'how_are_you', 'ack'].includes(intent)) {
    const t = plain(text)
    if (MUST.how_are_you.test(t) && !MUST.ack.test(t)) intent = 'how_are_you'
    else if (MUST.greeting.test(t)) intent = 'greeting'
  }
  if (intent !== 'claude' && !confirmed(intent, text)) intent = 'claude'
  if (intent === 'ack' && /\?\s*$/.test(lastSaid)) intent = 'claude'
  return { intent, say: replyFor(intent) }
}
