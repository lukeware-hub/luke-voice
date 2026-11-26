import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inputOptions, micConstraints, saveMicrophone, savedMicrophone } from './microphone.js'

const memory = () => {
  const data = new Map()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}

test('the saved choice survives a new run', () => {
  const storage = memory()
  assert.equal(savedMicrophone(storage), '')
  saveMicrophone('usb-1', storage)
  assert.equal(savedMicrophone(storage), 'usb-1')
})

test('a broken storage means the default microphone', () => {
  const broken = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
  assert.equal(savedMicrophone(broken), '')
  assert.doesNotThrow(() => saveMicrophone('x', broken))
})

test('a chosen microphone becomes a soft device request, none leaves the base alone', () => {
  assert.deepEqual(micConstraints('usb-1', { channelCount: 1 }), { channelCount: 1, deviceId: { ideal: 'usb-1' } })
  assert.deepEqual(micConstraints('', { channelCount: 1 }), { channelCount: 1 })
})

test('only audio inputs are listed, named, without the default alias', () => {
  const list = inputOptions([
    { kind: 'audioinput', deviceId: 'default', label: 'Padrão - Headset' },
    { kind: 'audioinput', deviceId: 'a', label: 'Headset' },
    { kind: 'audioinput', deviceId: 'b', label: '' },
    { kind: 'audiooutput', deviceId: 'c', label: 'Caixas' },
    { kind: 'videoinput', deviceId: 'd', label: 'Câmera' },
  ])
  assert.deepEqual(list, [
    { id: 'a', label: 'Headset' },
    { id: 'b', label: 'Microfone 2' },
  ])
})
