import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const CMD = join(ROOT, 'install', 'install-luke-voice-windows.cmd')
const UNCMD = join(ROOT, 'install', 'uninstall-luke-voice-windows.cmd')
const SH = join(ROOT, 'install', 'install.sh')
const UNSH = join(ROOT, 'install', 'uninstall.sh')

test('the Windows scripts are stored with CRLF line endings, as GitHub serves them; the shell ones with LF', () => {
  for (const file of [CMD, UNCMD]) {
    const bytes = readFileSync(file)
    const text = bytes.toString('utf8')
    // cmd.exe misreads a batch file with LF line endings and UTF-8 text: it runs comments as commands.
    assert.equal(/(^|[^\r])\n/.test(text), false, `${file}: every line ends with CRLF`)
    assert.equal(Buffer.from(text, 'utf8').equals(bytes), true, `${file}: valid UTF-8`)
  }
  for (const file of [SH, UNSH]) assert.equal(readFileSync(file, 'utf8').includes('\r'), false, `${file} keeps LF for bash`)
})

test('both installers pin the same Node.js version, each archive by sha256', () => {
  const cmd = readFileSync(CMD, 'utf8')
  const sh = readFileSync(SH, 'utf8')
  const version = /\$NodeVersion = '(v\d+\.\d+\.\d+)'/.exec(cmd)?.[1]
  assert.ok(version)
  assert.equal(/NODE_VERSION='(v\d+\.\d+\.\d+)'/.exec(sh)?.[1], version)
  for (const platform of ['win-x64', 'win-arm64']) assert.match(cmd, new RegExp(`'${platform}'\\s*=\\s*'[0-9a-f]{64}'`))
  for (const platform of ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) assert.match(sh, new RegExp(`${platform}\\) echo '[0-9a-f]{64}'`))
  for (const platform of ['64-bit', 'arm64']) assert.match(cmd, new RegExp(`'${platform}'\\s*=\\s*'[0-9a-f]{64}'`))
})

test('the shell scripts use nothing the bash 3.2 of macOS lacks', () => {
  for (const file of [SH, UNSH]) {
    const text = readFileSync(file, 'utf8')
    for (const [pattern, what] of [[/\[\[/, '[[ ]]'], [/declare -A|mapfile|readarray/, 'bash 4 builtins'], [/\$\{[a-zA-Z_]+(,,|\^\^)\}/, 'case changes'], [/readlink -f/, 'readlink -f'], [/stat -c|sed -i|grep -P|date -d/, 'GNU-only flags']]) {
      assert.doesNotMatch(text, pattern, `${file} uses ${what}`)
    }
  }
})

test('double-clicked, the Windows scripts reach their PowerShell part', { skip: process.platform !== 'win32' }, () => {
  for (const script of [CMD, UNCMD]) {
    const text = readFileSync(script, 'utf8')
    const end = text.indexOf('#>') + 2
    // The same file, with a first PowerShell line that only says it got there.
    const dir = mkdtempSync(join(tmpdir(), "luke-cmd-O'Brien "))
    const file = join(dir, 'script.cmd')
    writeFileSync(file, `${text.slice(0, end)}\r\nWrite-Output "PARSED OK: $env:LUKE_VOICE_SELF"; return\r\n${text.slice(end)}`)
    const run = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', file], { input: '\r\n', encoding: 'utf8' })
    assert.match(run.stdout, /PARSED OK: .*O'Brien/, script)
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /não é reconhecido|is not recognized/, script)
  }
})
