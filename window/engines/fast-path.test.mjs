import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONFIRM_PHRASES, isConfirm, isDeny, isMixed, isStopClaude, isStopOnly, stopTarget } from './fast-path.js'

test('a short stop request is caught, with or without accents, fillers or the name', () => {
  for (const said of ['Pare.', 'para!', 'Ceci, para tudo.', 'Luke, para tudo.', 'Nara, para tudo.', 'Para, Narah, para!', 'Nará, pare', 'PARA AGORA', 'cancela isso', 'chega', 'Pará.', 'para o Claude, por favor', 'Ceci, para.', 'Cecí, pare agora', 'Cecy, chega']) {
    assert.equal(isStopOnly(said), true, said)
  }
})

test('"para" inside a request is a preposition, not a stop', () => {
  for (const said of ['Cria uma tarefa para revisar os testes.', 'para que serve isso?', 'manda para o Claude', 'não para']) {
    assert.equal(isStopOnly(said), false, said)
  }
})

test('a short yes to "ok?" is a confirmation, as people say it and as Whisper writes it', () => {
  for (const said of ['Sim.', 'sim, pode', 'Pode.', 'Pode sim!', 'Manda ver.', 'Claro, pode fazer.', 'Sim, pode-se.', 'Sim, pode-ya!', 'Ok', 'Beleza, pode ir', 'Isso.', 'Bora!', 'Ceci, pode sim', 'Com certeza.']) {
    assert.equal(isConfirm(said), true, said)
    assert.equal(isDeny(said), false, said)
  }
})

test('a short no is a denial, and never a confirmation', () => {
  for (const said of ['Não.', 'Agora não.', 'Deixa pra lá.', 'Melhor não.', 'Esquece.', 'Não, obrigado.', 'Nao precisa']) {
    assert.equal(isDeny(said), true, said)
    assert.equal(isConfirm(said), false, said)
  }
})

test('an answer with a change, a question or a new request goes to the brain', () => {
  for (const said of ['Sim, mas só na pasta site.', 'Pode rodar os testes de pagamento também?', 'Verifica os testes de login.', 'Sim, e depois manda o resultado para o Claude', '']) {
    assert.equal(isConfirm(said), false, said)
    assert.equal(isDeny(said), false, said)
  }
})

test('a stop that names Claude or the task stops Claude; a bare one may be meant for Ceci alone', () => {
  for (const said of ['para o Claude', 'Ceci, para o Claude, por favor', 'cancela a tarefa', 'Cancela as tarefas.', 'para tudo', 'Pare a tarefa agora']) {
    assert.equal(isStopOnly(said), true, said)
    assert.equal(isStopClaude(said), true, said)
  }
  for (const said of ['Para.', 'chega', 'Ceci, para.', 'cancela isso', 'pare agora']) {
    assert.equal(isStopOnly(said), true, said)
    assert.equal(isStopClaude(said), false, said)
  }
  // Still a request, not a stop.
  assert.equal(isStopClaude('Cria uma tarefa para o Claude revisar os testes.'), false)
})

test('the name and repeated stop words may come anywhere among the stop words, as people say it', () => {
  for (const said of ['Para, Ceci, para!', 'Para Ceci, para', 'para, para', 'Para, para, para.', 'Ceci, para, por favor', 'chega, Ceci', 'Ceci, Ceci, para!', 'Cessi, chega, chega.', 'Pare agora, Ceci, por favor.', 'Para, Ceci, para o Claude.']) {
    assert.equal(isStopOnly(said), true, said)
  }
  // Only stop words, the name and fillers: anything else is a request.
  for (const said of ['Cria uma tarefa para revisar os testes.', 'Ceci, cria uma tarefa para o Claude.', 'Para, Ceci, e depois roda os testes.', 'Ceci, não para', 'Ceci para que serve isso?', 'Ceci', 'por favor, Ceci']) {
    assert.equal(isStopOnly(said), false, said)
  }
  // Whether Claude's work stops is unchanged: only when the stop names it.
  assert.equal(isStopClaude('Para, Ceci, para!'), false)
  assert.equal(isStopClaude('Para, Ceci, para o Claude.'), true)
  assert.equal(isStopClaude('chega, Ceci, para tudo'), true)
})

test('a bare stop only quiets Ceci; Claude\'s work stops only when the stop names it', () => {
  for (const said of ['Para.', 'cancela', 'Cancela.', 'chega', 'Ceci, para.', 'cancela isso', 'pare agora']) {
    assert.equal(stopTarget(said), 'ceci', said)
  }
  for (const said of ['para o Claude', 'cancela a tarefa', 'para tudo', 'Ceci, cancela as tarefas']) {
    assert.equal(stopTarget(said), 'claude', said)
  }
  for (const said of ['Cria uma tarefa para revisar os testes.', 'cancela a reunião de amanhã no calendário', 'oi']) {
    assert.equal(stopTarget(said), null, said)
  }
})

test('"espera", "cala a boca" and "para de falar" stop Ceci, and only Ceci', () => {
  for (const said of ['Espera.', 'espera aí', 'Ceci, espera', 'Cala a boca!', 'cala', 'Ceci, cala a boca', 'Para de falar.', 'para de falar, Ceci', 'espera, espera']) {
    assert.equal(isStopOnly(said), true, said)
    assert.equal(stopTarget(said), 'ceci', said)
  }
  // A longer sentence that starts with a stop word is a request, not a stop.
  for (const said of ['espera aí que eu quero falar outra coisa', 'de onde vem isso?', 'falar com o Claude', 'cala a boca do cachorro', 'espera o teste terminar e me avisa']) {
    assert.equal(isStopOnly(said), false, said)
    assert.equal(stopTarget(said), null, said)
  }
})

test('more ways to say yes: "tá bom", "pode ser", "uhum", "claro que sim", "manda bala"', () => {
  for (const said of ['Tá bom.', 'tá', 'Tá bom, pode fazer.', 'Pode ser.', 'Uhum.', 'Claro que sim!', 'Manda bala.', 'Ceci, tá bom']) {
    assert.equal(isConfirm(said), true, said)
    assert.equal(isDeny(said), false, said)
  }
})

test('the new yes words never turn a no, a doubt or a new request into a yes', () => {
  for (const said of ['Pode ser que não.', 'não tá bom', 'Tá bom não.', 'espera aí que eu quero falar outra coisa', 'Bom...', 'O quê?', 'pra quê?', 'não, tá bom assim', 'tá bom, mas só amanhã']) {
    assert.equal(isConfirm(said), false, said)
  }
  // A hedged no is a no: nothing runs.
  assert.equal(isDeny('Pode ser que não.'), true)
  // Neither yes nor no: these go to the brain.
  for (const said of ['não tá bom', 'espera aí que eu quero falar outra coisa', 'tá bom, mas só amanhã']) {
    assert.equal(isDeny(said), false, said)
  }
})

test('a question back is never a yes, even when made of yes words', () => {
  for (const said of ['Tá aí?', 'tá?', 'Sim?', 'Pode ser?', 'pode?', 'Tá aí', 'Ceci, tá aí?', 'O que?', 'Como assim, pode?', 'Onde?', 'Quando pode?', 'Por que, Ceci?', 'Ok?']) {
    assert.equal(isConfirm(said), false, said)
  }
  // Still yes: no question.
  for (const said of ['Tá.', 'Pode ser.', 'Sim, pode', 'Tá bom.', 'Claro que sim!', 'Ceci, pode sim']) {
    assert.equal(isConfirm(said), true, said)
  }
})

test('short yeses as the ears write them are yes: "Pod.", "Okei", "Isso...", "Sim, pode rodar"', () => {
  // "Pod." and "Isso" are what Qwen3-ASR wrote for a spoken "Pode." and "Isso." on the real engine.
  for (const said of ['Pod.', 'Okei.', 'Oquei', 'OK.', 'Isso...', 'Isso', 'Isso aí, pode rodar.', 'Sim, pode rodar.', 'Pode seguir.', 'Pode seguir em frente.', 'Aham.', 'Exato.', 'Fechou!', 'Pode continuar.']) {
    assert.equal(isConfirm(said), true, said)
    assert.equal(isDeny(said), false, said)
  }
  // Still to the brain: a request, a change or a doubt.
  for (const said of ['Pode rodar os testes de pagamento?', 'Roda os testes de login.', 'Isso não.', 'Pod?']) {
    assert.equal(isConfirm(said), false, said)
  }
})

test('any word or phrase that means yes is a yes, alone or combined with others', () => {
  const alone = ['sim', 'pode', 'ok', 'isso', 'claro', 'manda ver', 'tá bom', 'beleza', 'blz', 'legal', 'ótimo', 'lógico', 'óbvio', 'tranquilo', 'concordo', 'aceito', 'autorizado', 'aprovado', 'confirma', 'vamos', 'yeah', 'yep', 'sure', 'Ahã.', 'tudo bem', 'sem problema', 'de acordo', 'tá certo', 'está bem', 'sim senhor', 'pode crer', 'vamos nessa', 'manda brasa', 'vai fundo', 'isso mesmo', 'é isso aí']
  const combined = ['sim pode', 'sim ok', 'pode ok', 'ok pode', 'ok sim', 'sim, claro', 'claro, manda ver', 'isso, sim', 'tá bom, ok', 'Sim, pode, ok.', 'sim claro pode ok', 'ok, tudo bem', 'sim, sem problema', 'tá bom, de acordo', 'sim, por gentileza', 'Ceci, ok', 'ok, ótimo, pode ir']
  for (const said of [...alone, ...combined]) {
    assert.equal(isConfirm(said), true, said)
    assert.equal(isDeny(said), false, said)
  }
})

test('the extra yes words and phrases never turn a no, a doubt, a question or a request into a yes', () => {
  // "problema" and "acordo" are not yes words on their own; a no beside a yes stays a no or goes to the brain.
  for (const said of ['problema', 'de acordo com o quê', 'sem problema nenhum, mas só amanhã', 'não, tudo bem', 'não, ok', 'ok, não', 'sim, não', 'tudo bem?', 'Ceci, tudo bem?', 'sure?', 'legal?', 'ok, mas muda a pasta', 'Vamos rodar os testes de login', 'sem problema, e depois manda para o Claude']) {
    assert.equal(isConfirm(said), false, said)
  }
})

test("Ceci's own voice written down before the user's yes does not hide it", () => {
  const said = 'Vou rodar os testes do luke-voice e te conto o resultado. Posso?'
  // Her tail, partly misheard, then the user's "sim" (heard so on the real engine).
  for (const heard of ['De quanto o resultado? Posso. Sim.', 'Posso? Pode.', 'Te conto o resultado. Posso? Isso.']) {
    assert.equal(isConfirm(heard, said), true, heard)
    // Without knowing what she said, it stays with the brain.
    assert.equal(isConfirm(heard), false, heard)
  }
  // What comes before the yes is the user's, not her echo: the brain decides.
  for (const heard of ['Roda só os de pagamento. Sim.', 'Manda para outra sessão. Pode.']) {
    assert.equal(isConfirm(heard, said), false, heard)
  }
  // A no is never turned into a yes by her echo.
  assert.equal(isConfirm('Posso? Não.', said), false)
})

test('every way to say no is a no, alone or as a phrase, and never a yes', () => {
  for (const said of ['Não.', 'Naum', 'Num.', 'nope', 'Nunca.', 'Jamais!', 'Negativo.', 'Nada.', 'De jeito nenhum.', 'Nem pensar!', 'Claro que não.', 'Lógico que não', 'Acho que não.', 'Ainda não.', 'Agora não, Ceci.', 'Não, obrigado.', 'Deixa pra lá.', 'Esquece.', 'Cancela.']) {
    assert.equal(isDeny(said), true, said)
    assert.equal(isConfirm(said), false, said)
  }
  // A question back is not a no.
  for (const said of ['Não?', 'Nunca?']) assert.equal(isDeny(said), false, said)
})

test('a soft or quick answer the ears misheard counts only when it is the whole answer', () => {
  // A soft "sim" written as "Fim." or "Sin.", a "não" as "Mão." (heard on the real engine).
  for (const said of ['Fim.', 'Sin.', 'Si.', 'Ceci, fim']) {
    assert.equal(isConfirm(said), true, said)
    assert.equal(isDeny(said), false, said)
  }
  for (const said of ['Mão.', 'Nau.']) {
    assert.equal(isDeny(said), true, said)
    assert.equal(isConfirm(said), false, said)
  }
  // Inside a sentence they are just words: the brain decides.
  for (const said of ['fim da tarefa', 'Fim?', 'mão na massa', 'si mesmo']) {
    assert.equal(isConfirm(said), false, said)
    assert.equal(isDeny(said), false, said)
  }
})

test('a yes and a no in one short answer is mixed: neither a yes nor a no', () => {
  for (const said of ['sim, não', 'Não, sim.', 'não, ok', 'Ok... não.', 'Claro. Não.', 'beleza, não', 'sim não sim']) {
    assert.equal(isMixed(said), true, said)
    assert.equal(isConfirm(said), false, said)
    assert.equal(isDeny(said), false, said)
  }
  // A no made with yes-like words is still a plain no; a yes with a change goes to the brain.
  for (const said of ['Isso não.', 'Pode ser que não.', 'Claro que não.', 'não, tudo bem', 'Não tá bom.', 'Sim, mas não agora', 'sim', 'não', '']) {
    assert.equal(isMixed(said), false, said)
  }
})

test('every listed confirm phrase is a yes, the asked keywords among them, and at least thirty', () => {
  assert.ok(CONFIRM_PHRASES.length >= 30)
  for (const word of ['Sim.', 'Ok.', 'Prosseguir.', 'Pode continuar.', 'Pode ir.', 'Vai.']) assert.ok(CONFIRM_PHRASES.includes(word), word)
  for (const said of CONFIRM_PHRASES) {
    assert.equal(isConfirm(said), true, said)
    assert.equal(isDeny(said), false, said)
    assert.equal(isMixed(said), false, said)
  }
  // Without the period, in lower case, or with the name, as the ears write them.
  for (const said of ['prosseguir', 'pode continuar', 'pode ir', 'vai', 'Ceci, pode prosseguir', 'Sim, pode continuar, Ceci.']) assert.equal(isConfirm(said), true, said)
})

test('the going-on words never turn a no, a question or a request into a yes', () => {
  for (const said of ['Não prossiga.', 'Não, não continua.', 'Continua não.']) {
    assert.equal(isConfirm(said), false, said)
    assert.equal(isDeny(said), true, said)
  }
  for (const said of ['Prosseguir?', 'Pode ir?', 'Pode continuar?', 'Continua os testes de login.', 'Pode ir para a pasta site.', 'depois', 'não vai']) {
    assert.equal(isConfirm(said), false, said)
  }
})
