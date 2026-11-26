// The microphone the user picked in Configurações; empty means the system default.
const ITEM = 'ceci-microphone'

export function savedMicrophone(storage = globalThis.localStorage) {
  try {
    return storage.getItem(ITEM) ?? ''
  } catch {
    return ''
  }
}

export function saveMicrophone(id, storage = globalThis.localStorage) {
  try {
    storage.setItem(ITEM, id)
  } catch {
    // No storage: the choice holds until the window closes.
  }
}

// "ideal" falls back to the default microphone when the saved one is unplugged.
export function micConstraints(id, base = {}) {
  return id ? { ...base, deviceId: { ideal: id } } : base
}

// Audio inputs only, named; the "default" alias is dropped because the first option already is the default.
export function inputOptions(devices) {
  return devices
    .filter(device => device.kind === 'audioinput' && device.deviceId !== 'default')
    .map((device, index) => ({ id: device.deviceId, label: device.label || `Microfone ${index + 1}` }))
}
