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

const read = file => readFileSync(file, 'utf8')
const DOCS = ['INSTALL.md', 'README.md', 'README.pt-BR.md'].map(name => join(ROOT, name))

test('the Windows line works typed in PowerShell too: nothing inside its quotes for PowerShell to expand', () => {
  for (const file of [...DOCS, CMD, UNCMD]) {
    const lines = read(file).split(/\r?\n/).filter(line => /powershell\b.*-c "irm /.test(line))
    assert.ok(lines.length > 0, `${file} has the one-line command`)
    for (const line of lines) {
      const quoted = /-c "([^"]*)"/.exec(line)?.[1] ?? ''
      assert.doesNotMatch(quoted, /\$/, `${file}: ${line}`)
      assert.match(line, /powershell -NoProfile -ExecutionPolicy Bypass -c "irm https:\/\/raw\.githubusercontent\.com\/lukeware-hub\/luke-voice\/main\/install\/(un)?install-luke-voice-windows\.cmd \| iex"/, file)
    }
  }
  // The pause is decided inside: a window that closes by itself (Windows+R) waits for Enter.
  for (const file of [CMD, UNCMD]) assert.match(read(file), /\$parent\.Name -eq 'explorer\.exe'/)
})

test('the Windows scripts run claude as a program, never npm\'s claude.ps1, and find it beyond the PATH', () => {
  for (const file of [CMD, UNCMD]) {
    const text = read(file)
    assert.doesNotMatch(text, /& claude\b/, `${file} runs a bare claude`)
    assert.doesNotMatch(text, /\/c "claude /, `${file} runs a bare claude through cmd`)
    assert.match(text, /Get-Command claude -CommandType Application/)
    assert.match(text, /'\.local\\bin\\claude\.exe'/)
    assert.match(text, /'npm\\claude\.cmd'/)
  }
  for (const file of [SH, UNSH]) {
    const text = read(file)
    for (const where of ['$HOME/.local/bin/claude', '$HOME/.claude/local/claude', 'npm prefix -g', '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) assert.ok(text.includes(where), `${file} looks in ${where}`)
  }
  assert.doesNotMatch(read(SH), /^\s*(out=\$\()?claude /m, 'install.sh runs claude by the path it found')
})

test('claude\'s stdout alone is read as JSON; its stderr only explains a failure', () => {
  const sh = read(SH)
  assert.match(sh, /out=\$\("\$CLAUDE" "\$@" 2>"\$errfile"\)/)
  assert.doesNotMatch(sh, /run_claude[^\n]*2>&1/)
  for (const file of [CMD, UNCMD]) assert.match(read(file), /\$_ -is \[System\.Management\.Automation\.ErrorRecord\]/, file)
  assert.match(read(UNSH), /plugins=\$\("\$CLAUDE" plugin list --json 2>"\$errfile"\)/)
})

test('an old Node.js, or one that cannot use the proxy, gets luke-voice its own Node.js instead of stopping the install', () => {
  const sh = read(SH)
  const cmd = read(CMD)
  for (const text of [sh, cmd]) {
    assert.doesNotMatch(text, /antigo demais/)
    assert.match(text, /deste computador é antigo/)
    assert.match(text, /não baixa por ele/)
    assert.match(text, /a >= 24 \|\| \(a === 22 && b >= 21\)/)
  }
  // The node link goes into ~/.local/bin only, never next to claude (Homebrew's folder, or /mnt/c in WSL).
  assert.doesNotMatch(sh, /dirname "\$\(command -v claude\)"/)
  assert.match(sh, /ln -sf "\$dir\/bin\/node" "\$HOME\/\.local\/bin\/node"/)
  // On Windows the proxy Windows uses goes to Node.js for the download.
  assert.match(cmd, /\[Net\.WebRequest\]::GetSystemWebProxy\(\)/)
  assert.match(cmd, /\$env:HTTPS_PROXY = \$proxyAt/)
})

test('downloads use curl, else wget, and the docs give the wget line', () => {
  const sh = read(SH)
  assert.match(sh, /fetch\(\) \{\n\s+if command -v curl[^\n]*curl -fsSL "\$1" -o "\$2"\n\s+elif command -v wget[^\n]*wget -qO "\$2" "\$1"/)
  assert.doesNotMatch(sh.replace(/fetch\(\) \{[\s\S]*?\n\}/, ''), /curl -fsSL "http/, 'every download goes through fetch')
  for (const file of DOCS) assert.match(read(file), /wget -qO- https:\/\/raw\.githubusercontent\.com\/lukeware-hub\/luke-voice\/main\/install\/install\.sh \| bash/, file)
})

test('a prompt with no keyboard behind it is skipped, not a crash', () => {
  for (const file of [CMD, UNCMD]) {
    const text = read(file)
    assert.match(text, /-not \[Console\]::IsInputRedirected/)
    assert.doesNotMatch(text, /\(Read-Host[^)]*\)\.Trim\(\)/, `${file}: Read-Host can give back nothing`)
  }
  // node's stderr under 'Stop' must not end the install: its exit code says how setup went.
  assert.match(read(CMD), /\$ErrorActionPreference = 'Continue'\r?\n\s+& node \$setup\r?\n\s+\$setupCode = \$LASTEXITCODE/)
})

test('a full disk (setup exit code 2) is said as such by both installers', () => {
  assert.match(read(SH), /"\$setup_code" -eq 2/)
  assert.match(read(CMD), /\$setupCode -eq 2/)
  for (const file of [SH, CMD]) assert.match(read(file), /falta espaço no disco/)
})

test('the uninstallers close Claude Code first and say when a removal failed', () => {
  for (const file of [UNSH, UNCMD]) {
    const text = read(file)
    assert.match(text, /O Claude Code está aberto/)
    assert.match(text, /não consegui remover o luke-voice do Claude Code/)
    assert.doesNotMatch(text, /plugin uninstall[^\n]*(\|\| true|Out-Null)/, `${file} hides a failed uninstall`)
  }
  assert.match(read(UNSH), /pkill -f 'node \.\*luke-voice\.\*\/hub\/\(server\|guard\)\\\.mjs'/)
  assert.match(read(UNCMD), /hub\[\\\\\/\]\(server\|guard\)\\\.mjs/)
})

test('the sizes in the docs and installers are the ones the code downloads', async () => {
  const { BINARIES, groupBytes, profileGroups } = await import('./engine.mjs')
  const engine = Math.max(...Object.values(BINARIES).map(b => b.size))
  const natural = (groupBytes(profileGroups('gpu')) + engine) / 1e9
  const light = (groupBytes(profileGroups('light')) + engine) / 1e6
  const lightGpu = (groupBytes(profileGroups('light', [{}])) + engine) / 1e6
  const gb = natural.toFixed(1)
  assert.equal(gb, '3.3')
  for (const file of [SH, CMD]) assert.ok(read(file).includes(`até ${gb.replace('.', ',')} GB`), file)
  const about = n => `${Math.round(n / 10) * 10} MB`
  assert.ok(read(join(ROOT, 'INSTALL.md')).includes(`about ${gb} GB`) && read(join(ROOT, 'INSTALL.md')).includes(`about ${about(light)}`) && read(join(ROOT, 'INSTALL.md')).includes(`about ${about(lightGpu)}`))
  assert.ok(read(join(ROOT, 'README.md')).includes(`About ${gb} GB`) && read(join(ROOT, 'README.md')).includes(`about ${about(light)}`))
  assert.ok(read(join(ROOT, 'README.pt-BR.md')).includes(`Cerca de ${gb.replace('.', ',')} GB`) && read(join(ROOT, 'README.pt-BR.md')).includes(`cerca de ${about(light)}`))
  for (const file of DOCS) assert.doesNotMatch(read(file), /2[.,]8 GB|3[.,]5 GB|luke-voice 0\.9\.x/, file)
})

test('the shell scripts parse', { skip: spawnSync('bash', ['--version']).status !== 0 }, () => {
  for (const file of [SH, UNSH]) {
    // On stdin: on Windows, "bash" can be WSL's, which cannot read a C:\ path.
    const run = spawnSync('bash', ['-n'], { input: readFileSync(file), encoding: 'utf8' })
    assert.equal(run.status, 0, `${file}: ${run.stderr}`)
  }
})

test('the PowerShell part of the Windows scripts parses in Windows PowerShell 5.1', { skip: process.platform !== 'win32' }, () => {
  for (const file of [CMD, UNCMD]) {
    const script = `$t = [IO.File]::ReadAllText($env:LUKE_FILE, [Text.Encoding]::UTF8); $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, LUKE_FILE: file } })
    assert.equal(run.status, 0, `${file}: ${run.stdout}${run.stderr}`)
  }
})
