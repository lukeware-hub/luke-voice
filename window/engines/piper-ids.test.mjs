import assert from 'node:assert/strict'
import { test } from 'node:test'

import { phonemeIds } from './piper-ids.js'

const MAP = { _: [0], '^': [1], $: [2], ' ': [3], a: [14], 'ˈ': [120], o: [27], ',': [8], '̃': [141] }

test('ids are start, pad, then each phoneme with a pad after it, then end', () => {
  assert.deepEqual(phonemeIds('ˈao', MAP), [1, 0, 120, 0, 14, 0, 27, 0, 2])
})

test('unknown phonemes are dropped, and a combining mark is its own phoneme after NFD', () => {
  assert.deepEqual(phonemeIds('a?o', MAP), [1, 0, 14, 0, 27, 0, 2])
  // "ã" decomposes into "a" + U+0303, as piper does.
  assert.deepEqual(phonemeIds('ã', MAP), [1, 0, 14, 0, 141, 0, 2])
})

test('empty phonemes still give a valid start and end', () => {
  assert.deepEqual(phonemeIds('', MAP), [1, 0, 2])
  assert.deepEqual(phonemeIds(undefined, MAP), [1, 0, 2])
})
