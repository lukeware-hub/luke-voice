import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isConfirm, isDeny, isStopOnly } from './fast-path.js'

test('a short stop request is caught, with or without accents, fillers or the name', () => {
  for (const said of ['Pare.', 'para!', 'Ceci, para tudo.', 'Luke, para tudo.', 'PARA AGORA', 'cancela isso', 'chega', 'Pará.', 'para o Claude, por favor', 'Ceci, para.', 'Cecí, pare agora', 'Cecy, chega']) {
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
