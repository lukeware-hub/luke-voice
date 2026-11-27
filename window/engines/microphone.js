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

// Soft ("ideal") falls back to the default microphone when the saved one is unplugged, so a call still starts.
// Strict ("exact") fails instead, so the test never reports on a microphone the user did not pick.
export function micConstraints(id, base = {}, { strict = false } = {}) {
  return id ? { ...base, deviceId: strict ? { exact: id } : { ideal: id } } : base
}

// Audio inputs only, named, one per piece of hardware. Dropped: the "default" and "communications" aliases
// (the first option already is the default), entries with no id (the permission is not given yet),
// and a second entry of a group (a Bluetooth headset shows up as Hands-Free and Stereo).
export function inputOptions(devices) {
  const groups = new Set()
  return devices
    .filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
    .filter(device => {
      if (!device.groupId) return true
      if (groups.has(device.groupId)) return false
      groups.add(device.groupId)
      return true
    })
    .map((device, index) => ({ id: device.deviceId, label: device.label || `Microfone ${index + 1}` }))
}
