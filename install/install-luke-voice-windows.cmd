<# : batch part. Double-click this file to install luke-voice. The rest of the file is PowerShell.
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText('%~f0'); Invoke-Expression $s"
echo.
pause
exit /b
#>

# luke-voice installer for Windows. It installs the luke-voice mod into Claude Code, lets you pick
# Ceci's voice (free local, or ElevenLabs with your key), and checks that everything is in place.
# Without questions: set LUKE_VOICE_PROVIDER=local|elevenlabs and LUKE_VOICE_NO_PROMPT=1.
# The free voice is downloaded here: set LUKE_VOICE_PROFILE=gpu|light to force the natural voice on
# the GPU or the light browser voice instead of detecting it.
# set LUKE_VOICE_REF=<branch or tag> installs that version instead of main (to test a change).
# One line, from PowerShell, with no download:
#   powershell -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
$ErrorActionPreference = 'Stop'
$Plugin = 'luke-voice@luke-voice'
$Repo = 'lukeware-hub/luke-voice'
$Ref = "$env:LUKE_VOICE_REF".Trim()
$Source = if ($Ref) { "$Repo#$Ref" } else { $Repo }

function Say($text) { Write-Host $text }
function Step($n, $text) { Write-Host ""; Write-Host "[$n/6] $text" -ForegroundColor Cyan }
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
Write-Host "  Ceci, a voice assistant for Claude Code. This takes a few minutes."

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
# Claude Code keeps one source per marketplace: switching between main and a branch replaces it.
$added = & claude plugin marketplace add $Source 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $added -match 'Failed to add') {
  if ($added -match "source doesn't match") {
    Say "      Switching the luke-voice source to $Source."
    Run-Claude @('plugin', 'marketplace', 'remove', 'luke-voice') | Out-Null
    Run-Claude @('plugin', 'marketplace', 'add', $Source) | Out-Null
  } else {
    Fail "the command 'claude plugin marketplace add $Source' failed." $added.Trim()
  }
}
Run-Claude @('plugin', 'marketplace', 'update', 'luke-voice') | Out-Null
Run-Claude @('plugin', 'install', $Plugin) | Out-Null
Run-Claude @('plugin', 'update', $Plugin) | Out-Null
Ok 'luke-voice installed.'

Step 4 "Choosing Ceci's voice"
$config = Run-Claude @('plugin', 'configure', $Plugin, '--json') | ConvertFrom-Json
$hasKey = -not ($config.unconfigured -contains 'api_key')
$current = [string]$config.inputs.voice_provider
$canAsk = $env:LUKE_VOICE_NO_PROMPT -ne '1'
$provider = [string]$env:LUKE_VOICE_PROVIDER
if (-not $provider -and $canAsk) {
  Say '      Which voice should Ceci use?'
  Say '        Enter  Free voice, on your computer (recommended). No account, no key.'
  Say '        e      ElevenLabs. Paid per use; needs an ElevenLabs key.'
  $choice = (Read-Host '      Choice').Trim().ToLower()
  $provider = if (@('e', 'eleven', 'elevenlabs') -contains $choice) { 'elevenlabs' } else { 'local' }
}
# No answer and no choice: keep the saved one; someone who already has a key stays on ElevenLabs.
if (-not $provider) {
  $provider = if ($current) { $current } elseif ($hasKey) { 'elevenlabs' } else { 'local' }
}
if (@('local', 'elevenlabs') -notcontains $provider) { Fail "LUKE_VOICE_PROVIDER must be local or elevenlabs, not '$provider'." }

$key = ''
if ($provider -eq 'elevenlabs' -and $canAsk) {
  if ($hasKey) {
    Say '      An ElevenLabs key is already saved. Press Enter to keep it, or paste a new key to replace it.'
  } else {
    Say '      Get a key at https://elevenlabs.io/app/settings/api-keys (a free account works).'
    Say '      Paste it here and press Enter. It stays hidden. Press Enter alone to skip for now.'
  }
  $secure = Read-Host '      Key' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
}
# The values go on stdin, never the command line. Options left out keep their saved values.
$values = @{ voice_provider = $provider }
if ($key) { $values.api_key = $key }
$json = $values | ConvertTo-Json -Compress
$out = $json | & claude plugin configure $Plugin --values-stdin 2>&1 | Out-String
$saved = $LASTEXITCODE -eq 0
$values = $null; $json = $null
if (-not $saved) { Fail 'the settings could not be saved.' $out.Trim() }
if ($key) { $hasKey = $true }
$key = $null
if ($provider -eq 'local') {
  Ok 'Voice: free, on your computer.'
} else {
  Ok 'Voice: ElevenLabs.'
  if ($hasKey) { Ok 'ElevenLabs key saved in Claude Code secure storage.' } else { Say '      No key yet. Open this installer again to add it.' }
}

Step 5 'Checking the installation'
$list = Run-Claude @('plugin', 'list', '--json') | ConvertFrom-Json
$entry = @($list) | Where-Object { $_.id -eq $Plugin } | Select-Object -First 1
if (-not $entry) { Fail 'luke-voice is not in the list of installed plugins.' 'Check your internet connection.' }
if (-not $entry.enabled) {
  Run-Claude @('plugin', 'enable', $Plugin) | Out-Null
}
Ok "luke-voice $($entry.version) is installed and enabled."

$voiceReady = $false
if ($provider -eq 'local') {
  Step 6 "Downloading Ceci's voice (up to 3 GB, only once)"
  $setup = if ($entry.installPath) { Join-Path $entry.installPath 'hub\setup.mjs' } else { '' }
  if ($setup -and (Test-Path $setup)) {
    & node $setup
    if ($LASTEXITCODE -eq 0) {
      $voiceReady = $true
      Ok "Ceci's voice is ready."
    } else {
      Write-Host '      The voice is not ready yet. The first call finishes it, or type /luke-voice setup in Claude Code.' -ForegroundColor Yellow
    }
  } else {
    Say '      This version downloads the voice on the first call.'
  }
} else {
  Step 6 "Ceci's voice"
  Ok 'ElevenLabs needs no download.'
}

Write-Host ""
Write-Host "  ======================================" -ForegroundColor Green
Write-Host "   Installation complete: luke-voice $($entry.version)$(if ($Ref) { " (from $Ref)" })" -ForegroundColor Green
Write-Host "  ======================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Next:"
Write-Host "   1. Close Claude Code and open it again."
Write-Host "   2. Above the prompt, click the button 'luke-voice: off' to turn it on."
Write-Host "   3. Type /luke-voice call to start talking with Ceci."
Write-Host "   To switch the voice later: /luke-voice voz local or /luke-voice voz elevenlabs."
if ($provider -eq 'local' -and -not $voiceReady) {
  Write-Host ""
  Write-Host "  The first call finishes downloading the free voice, only once."
} elseif (-not $hasKey) {
  Write-Host ""
  Write-Host "  The ElevenLabs voice needs a key. Open this installer again to add it, or use the free voice." -ForegroundColor Yellow
}
