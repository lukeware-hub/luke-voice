<# : batch part. Double-click this file to install luke-voice. The rest of the file is PowerShell.
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText('%~f0'); Invoke-Expression $s"
echo.
pause
exit /b
#>

# luke-voice installer for Windows. It installs the luke-voice mod into Claude Code,
# asks for the ElevenLabs key (optional), and checks that everything is in place.
$ErrorActionPreference = 'Stop'
$Plugin = 'luke-voice@luke-voice'
$Repo = 'lukeware-hub/luke-voice'

function Say($text) { Write-Host $text }
function Step($n, $text) { Write-Host ""; Write-Host "[$n/5] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "      OK  $text" -ForegroundColor Green }
function Fail($text, $help) {
  Write-Host ""
  Write-Host "  Installation stopped: $text" -ForegroundColor Red
  if ($help) { Write-Host "  What to do: $help" -ForegroundColor Yellow }
  Write-Host "  Then open this installer again." -ForegroundColor Yellow
  exit 1
}
function Run-Claude([string[]]$CliArgs) {
  $out = & claude @CliArgs 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Fail "the command 'claude $($CliArgs -join ' ')' failed." $out.Trim() }
  return $out
}

Write-Host ""
Write-Host "  luke-voice installer" -ForegroundColor White
Write-Host "  A voice coworker for Claude Code. This takes about one minute."

Step 1 'Checking that Claude Code is installed'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Fail 'Claude Code was not found on this computer.' 'Install it from https://claude.com/claude-code and sign in once.'
}
Ok 'Claude Code found.'

Step 2 'Checking that Node.js 20 or newer is installed'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js was not found on this computer.' 'Install the LTS version from https://nodejs.org (use the default options).'
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Fail "Node.js $major is too old." 'Install the LTS version from https://nodejs.org.' }
Ok "Node.js $major found."

Step 3 'Installing the luke-voice mod'
Run-Claude @('plugin', 'marketplace', 'add', $Repo) | Out-Null
Run-Claude @('plugin', 'marketplace', 'update', 'luke-voice') | Out-Null
Run-Claude @('plugin', 'install', $Plugin) | Out-Null
Run-Claude @('plugin', 'update', $Plugin) | Out-Null
Ok 'luke-voice installed.'

Step 4 'ElevenLabs key (the voice needs it)'
$config = Run-Claude @('plugin', 'configure', $Plugin, '--json') | ConvertFrom-Json
$hasKey = -not ($config.unconfigured -contains 'api_key')
$key = ''
if ($env:LUKE_VOICE_NO_PROMPT -ne '1') {
  if ($hasKey) {
    Say '      A key is already saved. Press Enter to keep it, or paste a new key to replace it.'
  } else {
    Say '      Get a key at https://elevenlabs.io/app/settings/api-keys (a free account works).'
    Say '      Paste it here and press Enter. It stays hidden. Press Enter alone to skip for now.'
  }
  $secure = Read-Host '      Key' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
}
if ($key) {
  $json = @{ api_key = $key } | ConvertTo-Json -Compress
  $out = $json | & claude plugin configure $Plugin --values-stdin 2>&1 | Out-String
  $key = $null; $json = $null
  if ($LASTEXITCODE -ne 0) { Fail 'the key could not be saved.' $out.Trim() }
  $hasKey = $true
  Ok 'Key saved in Claude Code secure storage.'
} elseif ($hasKey) {
  Ok 'Kept the saved key.'
} else {
  Say '      Skipped. You can open this installer again later to add the key.'
}

Step 5 'Checking the installation'
$list = Run-Claude @('plugin', 'list', '--json') | ConvertFrom-Json
$entry = @($list) | Where-Object { $_.id -eq $Plugin } | Select-Object -First 1
if (-not $entry) { Fail 'luke-voice is not in the list of installed plugins.' 'Check your internet connection.' }
if (-not $entry.enabled) {
  Run-Claude @('plugin', 'enable', $Plugin) | Out-Null
}
Ok "luke-voice $($entry.version) is installed and enabled."

Write-Host ""
Write-Host "  ======================================" -ForegroundColor Green
Write-Host "   Installation complete: luke-voice $($entry.version)" -ForegroundColor Green
Write-Host "  ======================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Next:"
Write-Host "   1. Close Claude Code and open it again."
Write-Host "   2. Above the prompt, click the button 'luke-voice: off' to turn it on."
Write-Host "   3. Type /luke-voice call to start talking."
if (-not $hasKey) {
  Write-Host ""
  Write-Host "  The voice needs an ElevenLabs key. Open this installer again to add it." -ForegroundColor Yellow
}
