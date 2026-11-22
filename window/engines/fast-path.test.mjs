import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isConfirm, isDeny, isStopClaude, isStopOnly, stopTarget } from './fast-path.js'

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

test('a short yes to "posso?" is a confirmation, as people say it and as Whisper writes it', () => {
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
