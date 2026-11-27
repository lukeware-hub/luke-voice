import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inputOptions, micConstraints, resolveMicrophone, saveMicrophone, savedMicrophone } from './microphone.js'

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

test('a strict request asks for exactly the chosen microphone, so a wrong id fails loudly', () => {
  assert.deepEqual(micConstraints('usb-1', { channelCount: 1 }, { strict: true }), { channelCount: 1, deviceId: { exact: 'usb-1' } })
  assert.deepEqual(micConstraints('', { channelCount: 1 }, { strict: true }), { channelCount: 1 })
})

test('devices without an id (permission not given yet) are not listed', () => {
  assert.deepEqual(inputOptions([{ kind: 'audioinput', deviceId: '', label: '' }]), [])
})

test('the "communications" alias is dropped, the real device stays', () => {
  const list = inputOptions([
    { kind: 'audioinput', deviceId: 'communications', label: 'Comunicações - Headset', groupId: 'g1' },
    { kind: 'audioinput', deviceId: 'a', label: 'Headset', groupId: 'g1' },
  ])
  assert.deepEqual(list, [{ id: 'a', label: 'Headset' }])
})

test('a call opens the saved microphone while it is plugged in', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Padrão' },
    { kind: 'audioinput', deviceId: 'usb-1', label: 'USB' },
  ]
  assert.deepEqual(resolveMicrophone('usb-1', devices), { inputDeviceId: 'usb-1', fellBack: false })
})

test('an unplugged saved microphone falls back to the default, and says so', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Padrão' },
    { kind: 'audiooutput', deviceId: 'usb-1', label: 'USB (saída)' },
  ]
  assert.deepEqual(resolveMicrophone('usb-1', devices), { inputDeviceId: '', fellBack: true })
})

test('no saved choice is the default, with nothing to warn about', () => {
  assert.deepEqual(resolveMicrophone('', [{ kind: 'audioinput', deviceId: 'a' }]), { inputDeviceId: '', fellBack: false })
})

test('devices without ids prove nothing: the saved microphone is kept', () => {
  assert.deepEqual(resolveMicrophone('usb-1', [{ kind: 'audioinput', deviceId: '' }]), { inputDeviceId: 'usb-1', fellBack: false })
  assert.deepEqual(resolveMicrophone('usb-1', []), { inputDeviceId: 'usb-1', fellBack: false })
})

test('the same hardware seen twice (same group) is listed once; unknown groups are kept', () => {
  const list = inputOptions([
    { kind: 'audioinput', deviceId: 'a', label: 'Headset (Hands-Free)', groupId: 'g1' },
    { kind: 'audioinput', deviceId: 'b', label: 'Headset (Stereo)', groupId: 'g1' },
    { kind: 'audioinput', deviceId: 'c', label: 'USB', groupId: '' },
    { kind: 'audioinput', deviceId: 'd', label: 'Webcam', groupId: '' },
  ])
  assert.deepEqual(list.map(item => item.id), ['a', 'c', 'd'])
})
