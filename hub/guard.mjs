// Stops the engine's servers when the hub dies, even when it is killed (Task Manager, a crash, a
// kill signal): then the hub's exit handlers never run. The hub holds this process's stdin, and the
// operating system closes it with the hub. Lines "+<pid>" and "-<pid>" add and remove servers;
// at the end of input, the ones still listed are stopped. They are still running at that moment
// (the hub removes a pid when its server exits), so a pid cannot belong to another program yet.

const pids = new Set()
let pending = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  pending += chunk
  const lines = pending.split('\n')
  pending = lines.pop()
  for (const line of lines) {
    const pid = Number(line.slice(1))
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (line[0] === '+') pids.add(pid)
    if (line[0] === '-') pids.delete(pid)
  }
})

process.stdin.on('end', () => {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
  }
  process.exit(0)
})
