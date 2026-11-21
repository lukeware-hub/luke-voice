import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const CMD = join(ROOT, 'install', 'install-luke-voice-windows.cmd')
const SH = join(ROOT, 'install', 'install.sh')

test('the Windows installer is stored with CRLF line endings, as GitHub serves it', () => {
  const bytes = readFileSync(CMD)
  const text = bytes.toString('utf8')
  // cmd.exe misreads a batch file with LF line endings and UTF-8 text: it runs comments as commands.
  assert.equal(/(^|[^\r])\n/.test(text), false, 'every line ends with CRLF')
  assert.equal(Buffer.from(text, 'utf8').equals(bytes), true, 'valid UTF-8')
  assert.equal(readFileSync(SH, 'utf8').includes('\r'), false, 'install.sh keeps LF for bash')
})

test('both installers pin the same Node.js version, each archive by sha256', () => {
  const cmd = readFileSync(CMD, 'utf8')
  const sh = readFileSync(SH, 'utf8')
  const version = /\$NodeVersion = '(v\d+\.\d+\.\d+)'/.exec(cmd)?.[1]
  assert.ok(version)
  assert.equal(/NODE_VERSION='(v\d+\.\d+\.\d+)'/.exec(sh)?.[1], version)
  for (const platform of ['win-x64', 'win-arm64']) assert.match(cmd, new RegExp(`'${platform}'\\s*=\\s*'[0-9a-f]{64}'`))
  for (const platform of ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) assert.match(sh, new RegExp(`${platform}\\) echo '[0-9a-f]{64}'`))
})

test('double-clicked, the Windows installer reaches its PowerShell part', { skip: process.platform !== 'win32' }, () => {
  const text = readFileSync(CMD, 'utf8')
  const end = text.indexOf('#>') + 2
  // The same file, with a first PowerShell line that only says it got there.
  const dir = mkdtempSync(join(tmpdir(), "luke-cmd-O'Brien "))
  const file = join(dir, 'install-luke-voice-windows.cmd')
  writeFileSync(file, `${text.slice(0, end)}\r\nWrite-Output "PARSED OK: $env:LUKE_VOICE_SELF"; return\r\n${text.slice(end)}`)
  const run = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', file], { input: '\r\n', encoding: 'utf8' })
  assert.match(run.stdout, /PARSED OK: .*O'Brien/)
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /não é reconhecido|is not recognized/)
})
