import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CORPUS } from './speech-text.corpus.mjs'
import { chunks, numberWords, plainText, respell, respellNative, sentences, speechChunks, spokenForms } from './speech-text.js'

const SNAPSHOT = JSON.parse(readFileSync(new URL('./speech-text.snapshot.json', import.meta.url), 'utf8'))

test('markdown and code are dropped, the words stay', () => {
  const text = '## Pronto\n\nCorrigi o **login** em `auth.ts`:\n\n```ts\nconst x = 1\n```\n- veja [o PR](https://github.com/x/y/pull/2)'
  assert.equal(plainText(text), 'Pronto. Corrigi o login em auth.ts: veja o PR')
})

test('English tech words are respelled for a pt-BR voice, in any case, and other words stay', () => {
  assert.equal(respell('Abri a API e corrigi 2 BUGS na branch do Claude.'), 'Abri a a pê i e corrigi 2 bâgs na brentch do clód.')
  assert.equal(respell('A casa é azul'), 'A casa é azul')
})

test('text is cut into sentences, and a long sentence at a comma or space', () => {
  assert.deepEqual(chunks('Oi. Tudo bem? Sim!'), ['Oi.', 'Tudo bem?', 'Sim!'])
  const long = `${'palavra '.repeat(40)}fim.`
  const parts = chunks(long, 100)
  assert.ok(parts.length > 1)
  assert.ok(parts.every(p => p.length <= 100))
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.trim())
})

test('the first chunk is cut short at a comma, so the voice starts sooner', () => {
  const parts = speechChunks('Terminei a tarefa no projeto de autenticação, e todos os testes passaram sem nenhum erro. Pode seguir.')
  assert.equal(parts[0], 'Terminei a tarefa no projeto de autenticação,')
  assert.equal(parts[1], 'e todos os testes passaram sem nenhum erro.')
  assert.equal(parts[2], 'Pode seguir.')
})

test('empty or missing text gives nothing to say', () => {
  assert.deepEqual(speechChunks(''), [])
  assert.deepEqual(speechChunks(undefined), [])
  assert.deepEqual(speechChunks('```\ncode only\n```'), [])
})

test('times and percentages are written the way a Brazilian reads them; plain numbers are left to the voice', async () => {
  assert.equal(spokenForms('O deploy subiu às 17h30 e terminou às 18h.'), 'O deploy subiu às 17 e 30 e terminou às 18 horas.')
  assert.equal(spokenForms('Reunião às 9:05, 1h e 12:00.'), 'Reunião às 9 e 05, uma hora e 12 horas.')
  assert.equal(spokenForms('Cobertura de 85% e 3 %.'), 'Cobertura de 85 por cento e 3 por cento.')
  assert.equal(spokenForms('A porta 4848 e 1.500 usuários.'), 'A porta 4848 e 1.500 usuários.')
})

test('the native voice keeps most English tech words as they are; the browser voices get them respelled', () => {
  assert.deepEqual(speechChunks('Fiz o commit na branch main.', { isNative: true }), ['Fiz o commit na branch main.'])
  assert.deepEqual(speechChunks('Fiz o commit na branch main.'), ['Fiz o comít na brentch main.'])
})

test('the native voice gets its own spelling for the tech words it says in Portuguese, in any case', () => {
  assert.equal(respellNative('O TOKEN fica no cache, e o Backend chama o endpoint.'), 'O TOKEN fica no quéche, e o Back End chama o End Point.')
  assert.equal(respellNative('Abri o pull request da feature e pedi um review.'), 'Abri o pull request da Feature e pedi um Riviú.')
  assert.equal(respellNative('Rodei os hooks, fiz o rebase e atualizei o changelog.'), 'Rodei os ruks, fiz o rebase e atualizei o tchêindj log.')
  assert.equal(respellNative('A release passou no pipeline, no workflow e no checkout do frontend.'), 'A Rilíss passou no paip láin, no work flow e no check out do front-end.')
  assert.deepEqual(speechChunks('O framework lê o state do store.', { isNative: true }), ['O Framework lê o State do store.'])
})

test('the native voice gets luke-voice and Claude Code in the spelling it says in English', () => {
  assert.deepEqual(speechChunks('Seja bem-vindo ao luke-voice. Mande para o Claude Code.', { isNative: true }), ['Seja bem-vindo ao Luke Vóiss. Mande para o Clód Code.'])
  // Mid-sentence the comma stays, so "Code" does not run into the next word; before a mark it goes.
  assert.equal(respellNative('Abri o Claude Code e o Luke Voice.'), 'Abri o Clód Code, e o Luke Vóiss.')
  assert.equal(respellNative('O claude  CODE, depois; "Claude Code"'), 'O Clód Code, depois; "Clód Code"')
  // Other words around them stay: a lone Claude, and a longer name with the hyphen.
  for (const text of ['Pergunte ao Claude.', 'Use o luke-voice-studio.', 'O luke-voices e o claude-code.']) assert.equal(respellNative(text), text)
  // The browser voices keep their own respelling.
  assert.deepEqual(speechChunks('Abri o Claude Code.'), ['Abri o clód Code.'])
})

test('the native voice says "tudo bem" the Brazilian way, "túdu bêin"; the browser voices as written', () => {
  assert.deepEqual(speechChunks('Boa noite! Tudo bem? Eu sou o Luke.', { isNative: true }), ['Boa noite! Túdu bêin? Eu sou o Luke.'])
  assert.equal(respellNative('Está tudo bem com o build.'), 'Está túdu bêin com o build.')
  for (const text of ['Fiz tudo.', 'Muito bem.', 'tudo bemzinho', 'Tudo, bem rápido.']) assert.equal(respellNative(text), text)
  assert.deepEqual(speechChunks('Tudo bem?'), ['Tudo bem?'])
})

test('the native voice says the owner name the Brazilian way, "Djiêgo"; the browser voices keep "Diego"', () => {
  assert.deepEqual(speechChunks('Pronto, Diego, terminei.', { isNative: true }), ['Pronto, Djiêgo, terminei.'])
  assert.equal(respellNative('O DIEGO pediu.'), 'O Djiêgo pediu.')
  for (const text of ['Diegos', 'San-Diego']) assert.equal(respellNative(text), text)
  assert.deepEqual(speechChunks('Pronto, Diego.'), ['Pronto, Diego.'])
})

test('the native voice gets a sentence-opening "Claro" in the spelling it says right', () => {
  assert.deepEqual(speechChunks('Claro.', { isNative: true }), ['claro.'])
  assert.deepEqual(speechChunks('Entendi. Claro!', { isNative: true }), ['Entendi. claro!'])
  assert.deepEqual(speechChunks('Claro que sim, pode deixar comigo.', { isNative: true }), ['Claro que sim, pode deixar comigo.'.replace('Claro', 'Claaro')])
  // Mid-sentence, with a comma, or as another word: untouched. The browser voices are untouched too.
  assert.deepEqual(speechChunks('Claro, posso fazer isso.', { isNative: true }), ['Claaro, posso fazer isso.'])
  for (const text of ['Ficou claro para você?', 'Isso é claro.', 'Está claro, posso fazer.', 'Claramente errado.', 'Mas Claro que sim.']) assert.equal(respellNative(text), text)
  assert.deepEqual(speechChunks('Claro.'), ['Claro.'])
})

test('the native voice says "Bom dia!" with a double mark, so it does not come out as "bem dia"', () => {
  assert.deepEqual(speechChunks('Bom dia! Eu sou a Ceci.', { isNative: true }), ['Bom dia!! Eu sou a Ceci.'])
  assert.equal(respellNative('Olá, bom dia!'), 'Olá, bom dia!!')
  for (const text of ['Bom dia!!', 'Bom dia, Ana.', 'Tenha um bom dia.']) assert.equal(respellNative(text), text)
  assert.deepEqual(speechChunks('Bom dia! Eu sou a Ceci.'), ['Bom dia!', 'Eu sou a Ceci.'])
})

test('the native spelling touches whole words only, and leaves the rest of the sentence alone', () => {
  for (const text of ['Os tokens e o cached ficam no back-end.', 'O reviewer e o hookah.', 'A casa é azul, e o estado é bom.', 'O caché do cachecol.']) {
    assert.equal(respellNative(text), text)
  }
  assert.equal(respellNative('Hooks, cache.'), 'ruks, quéche.')
  assert.equal(respellNative('O hook e o reviewer.'), 'O ruk e o reviewer.')
})

test('the native voice packs short sentences into one chunk, so a line is said in one voice', () => {
  // The greeting that changed voice three times, once per sentence: now one chunk, one voice.
  assert.deepEqual(speechChunks('Boa noite! Tudo bem? Eu sou o Luke. O que a gente vai fazer hoje?', { isNative: true }), ['Boa noite! Túdu bêin? Eu sou o Luke. O que a gente vai fazer hoje?'])
  assert.deepEqual(speechChunks('Você quer que eu verifique os testes de login no repositório api? Posso?', { isNative: true }), ['Você quer que eu verifique os testes de login no repositório api? Posso?'])
  // A short first clause is never said on its own ("Certo," alone came out in another voice).
  assert.deepEqual(speechChunks('Certo, vou verificar os testes de login no repositório api agora.', { isNative: true }), ['Certo, vou verificar os testes de login no repositório api agora.'])
  // After the first chunk (at most 90 characters), sentences pack up to 220.
  const long = 'Terminei a tarefa no projeto de autenticação do serviço de pagamentos, e todos os testes passaram sem nenhum erro. Pode seguir. Quer que eu faça mais alguma coisa?'
  assert.deepEqual(speechChunks(long, { isNative: true }), ['Terminei a tarefa no projeto de autenticação do serviço de pagamentos,', 'e todos os testes passaram sem nenhum erro. Pode seguir. Quer que eu faça mais alguma coisa?'])
  // Nothing is lost or added, apart from the spaces between the chunks.
  const many = Array.from({ length: 12 }, (_, i) => `Esta é a frase número ${i + 1} da resposta.`).join(' ')
  const out = speechChunks(many, { isNative: true })
  assert.equal(out.join(' '), many)
  assert.ok(out[0].length <= 90 && out.every(chunk => chunk.length <= 220), JSON.stringify(out))
})

test('a question is never cut early, so the voice sees its "?" and rises at the end', () => {
  assert.deepEqual(speechChunks('Certo, quer que eu rode os testes de login no repositório api agora?', { isNative: true }), ['Certo, quer que eu rode os testes de login no repositório api agora?'])
})

test('ordinary sentences are cut and spelled as the snapshot says, on both voices (the native voice packs them into chunks since 0.23.3)', () => {
  assert.ok(CORPUS.length >= 40)
  assert.deepEqual(SNAPSHOT.map(s => s.text), CORPUS)
  for (const { text, native, browser } of SNAPSHOT) {
    assert.deepEqual(speechChunks(text, { isNative: true }), native, text)
    assert.deepEqual(speechChunks(text), browser, text)
  }
})

test('a sentence ends at a period followed by a space, never inside a number, a file name or a domain', () => {
  assert.deepEqual(sentences('O Opus 5.5 saiu. Ele é rápido.'), ['O Opus 5.5 saiu.', 'Ele é rápido.'])
  assert.deepEqual(sentences('Custa 1.500,00 por mês.'), ['Custa 1.500,00 por mês.'])
  assert.deepEqual(sentences('Corrigi o app.js e o www.site.com agora.'), ['Corrigi o app.js e o www.site.com agora.'])
  assert.deepEqual(sentences('Ele disse "ok." Depois saiu!'), ['Ele disse "ok."', 'Depois saiu!'])
  assert.deepEqual(sentences('... ?'), [])
})

test('no cut after a common abbreviation; "etc." ends a sentence only when the next word is capitalized', () => {
  assert.deepEqual(sentences('O Sr. Silva e a Dra. Ana chegaram com o Prof. Lima.'), ['O Sr. Silva e a Dra. Ana chegaram com o Prof. Lima.'])
  assert.deepEqual(sentences('Use, p.ex., o tema escuro, ex. o padrão. Veja o n. 5 e o React vs. Vue.'), ['Use, p.ex., o tema escuro, ex. o padrão.', 'Veja o n. 5 e o React vs. Vue.'])
  assert.deepEqual(sentences('Testes, builds etc. e mais. Lint etc. Depois.'), ['Testes, builds etc. e mais.', 'Lint etc.', 'Depois.'])
})

test('numbers in words, masculine and feminine', () => {
  const said = [0, 1, 2, 16, 21, 100, 101, 150, 200, 999, 1000, 1001, 1500, 1550, 2000, 21000, 100000, 1000000, 1200000, 1250000, 2000000, 1000000000]
  assert.deepEqual(said.map(n => numberWords(n)), [
    'zero', 'um', 'dois', 'dezesseis', 'vinte e um', 'cem', 'cento e um', 'cento e cinquenta', 'duzentos', 'novecentos e noventa e nove', 'mil', 'mil e um', 'mil e quinhentos', 'mil quinhentos e cinquenta', 'dois mil', 'vinte e um mil', 'cem mil', 'um milhão', 'um milhão e duzentos mil', 'um milhão duzentos e cinquenta mil', 'dois milhões', 'um bilhão',
  ])
  assert.deepEqual([1, 2, 21, 22, 200].map(n => numberWords(n, { isFeminine: true })), ['uma', 'duas', 'vinte e uma', 'vinte e duas', 'duzentas'])
})

test('hours take the feminine where a digit would not (1, 2, 21, 22), and 1h30 is a duration unless it is a time of day', () => {
  assert.equal(spokenForms('Leva 1h, 2h, 11h, 12h, 21h, 22h e 48h.'), 'Leva uma hora, duas horas, 11 horas, 12 horas, vinte e uma horas, vinte e duas horas e 48 horas.')
  assert.equal(spokenForms('Demorou 1h30 e depois 2h15min.'), 'Demorou uma hora e 30 minutos e depois duas horas e 15 minutos.')
  assert.equal(spokenForms('Reunião às 21h30, às 1h30 e 17h45.'), 'Reunião às vinte e uma e 30, às uma e 30 e 17 e 45.')
  assert.equal(spokenForms('Às 22:00 e 1h01min.'), 'Às vinte e duas horas e uma hora e 1 minuto.')
  // The voice already says "30min" right; it stays.
  assert.equal(spokenForms('Mais 30min.'), 'Mais 30min.')
})

test('dates are read as day and month, and a bare fraction stays a fraction', () => {
  assert.equal(spokenForms('O prazo é 22/11/2026, ou 01/12/26, ou 15/3.'), 'O prazo é 22 de novembro de 2026, ou primeiro de dezembro de 2026, ou 15 de março.')
  assert.equal(spokenForms('Use 1/2 xícara, 3/4 do tempo, e 32/13 não é data.'), 'Use 1/2 xícara, 3/4 do tempo, e 32/13 não é data.')
})

test('a count like "12/12 passaram" stays a count; a day the month does not have is no date', () => {
  assert.equal(spokenForms('Os testes: 12/12 passaram, 10/12 testes ok, 11/12 dos casos.'), 'Os testes: 12/12 passaram, 10/12 testes ok, 11/12 dos casos.')
  assert.equal(spokenForms('Rodou 30/02 e 31/04.'), 'Rodou 30/02 e 31/04.')
  // Real dates still read as dates, also before other words.
  assert.equal(spokenForms('Em 12/12 passamos lá, e 29/02 é bissexto.'), 'Em 12 de dezembro passamos lá, e 29 de fevereiro é bissexto.')
  assert.equal(spokenForms('Até 10/12/2026 passaram 3.'), 'Até 10 de dezembro de 2026 passaram 3.')
})

test('reais and centavos are said in words; big round amounts keep their digits', () => {
  assert.equal(spokenForms('Custa R$ 1.500,00, R$ 2,50, R$1,01 ou R$ 0,99.'), 'Custa mil e quinhentos reais, dois reais e cinquenta centavos, um real e um centavo ou noventa e nove centavos.')
  assert.equal(spokenForms('R$ 1.000.000,00 e R$ 3.250,90.'), 'um milhão de reais e três mil duzentos e cinquenta reais e noventa centavos.')
  assert.equal(spokenForms('Um aporte de R$ 2 milhões e R$ 1,5 mil.'), 'Um aporte de 2 milhões de reais e 1,5 mil reais.')
  // One digit of cents is tens of cents: "R$ 10,5" is ten reais and fifty.
  assert.equal(spokenForms('Custa R$ 10,5 ou R$ 0,5.'), 'Custa dez reais e cinquenta centavos ou cinquenta centavos.')
})

test('a clock with seconds is read whole, and hh:mm still reads as a time of day', () => {
  assert.equal(spokenForms('O log marca 10:30:45 e 00:05:01.'), 'O log marca 10 horas, 30 minutos e 45 segundos e 5 minutos e 1 segundo.')
  assert.equal(spokenForms('Às 21:00:00 e às 9:05.'), 'Às vinte e uma horas e às 9 e 05.')
})

test('a named version is read with "ponto" even where it looks like thousands', () => {
  assert.equal(spokenForms('Saiu a v1.234, a versão 1.234 e a version 2.500.'), 'Saiu a versão 1 ponto 234, a versão 1 ponto 234 e a version 2 ponto 500.')
  assert.equal(spokenForms('Instalei a v0.10.13 para 1.500 usuários, e a v2 continua.'), 'Instalei a versão 0 ponto 10 ponto 13 para 1.500 usuários, e a v2 continua.')
})

test('versions are said with "ponto"; thousands stay; abbreviations the voice misreads are said in full', () => {
  assert.equal(spokenForms('O Opus 5.5 e a versão 0.10.3, com 1.500 usuários.'), 'O Opus 5 ponto 5 e a versão 0 ponto 10 ponto 3, com 1.500 usuários.')
  assert.equal(spokenForms('Prof. Lima, use p.ex. o React vs. Vue. Ex.: rode.'), 'Professor Lima, use por exemplo o React versus Vue. Por exemplo: rode.')
  assert.equal(spokenForms('O Sr. Silva e o nº 5.'), 'O Sr. Silva e o nº 5.')
})

test('markup leftovers: snake_case, arithmetic, domains, emoji and list items', () => {
  assert.equal(plainText('Use snake_case_names e um _destaque_ aqui.'), 'Use snake case names e um destaque aqui.')
  assert.equal(plainText('A conta é 2 * 3 = 6, 2*3*4, e *ênfase* fica.'), 'A conta é 2 vezes 3 = 6, 2 vezes 3 vezes 4, e ênfase fica.')
  assert.equal(plainText('Acesse www.site.com.br ou exemplo.org, não o app.js.'), 'Acesse site ponto com ponto bê erre ou exemplo ponto org, não o app.js.')
  assert.equal(plainText('Pronto! \u{1F389} Tudo certo \u{2705}. Valeu \u{1F44D}\u{1F3FD}'), 'Pronto! Tudo certo. Valeu')
  assert.equal(plainText('Fiz três coisas:\n- Revisei\n- Testei\n\n1. Primeiro\n2. Segundo'), 'Fiz três coisas: Revisei. Testei. Primeiro. Segundo')
  assert.deepEqual(speechChunks('Fiz três coisas:\n- Revisei o código\n- Rodei os testes', { isNative: true }), ['Fiz três coisas: Revisei o código. Rodei os testes'])
})
