import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isStopOnly } from './fast-path.js'

test('a short stop request is caught, with or without accents, fillers or the name', () => {
  for (const said of ['Pare.', 'para!', 'Luke, para tudo.', 'PARA AGORA', 'cancela isso', 'chega', 'Pará.', 'para o Claude, por favor']) {
    assert.equal(isStopOnly(said), true, said)
  }
})

test('"para" inside a request is a preposition, not a stop', () => {
  for (const said of ['Cria uma tarefa para revisar os testes.', 'para que serve isso?', 'manda para o Claude', 'não para']) {
    assert.equal(isStopOnly(said), false, said)
  }
})
