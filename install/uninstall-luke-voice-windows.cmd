<# : batch part. Double-click this file to remove luke-voice. The rest of the file is PowerShell.
@echo off
setlocal
rem The path goes through the environment: a quote in it (C:\Users\O'Brien) would end a PowerShell string.
set "LUKE_VOICE_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText($env:LUKE_VOICE_SELF, [Text.Encoding]::UTF8); Invoke-Expression $s"
set "LUKE_VOICE_CODE=%errorlevel%"
echo.
pause
exit /b %LUKE_VOICE_CODE%
#>

# luke-voice uninstaller for Windows. It stops Ceci, removes the luke-voice mod from Claude Code,
# deletes luke-voice's folder (the voice, and the Node.js and Git the installer brought) and takes
# those two off this user's PATH. Nothing else on the computer changes.
# Without questions: set LUKE_VOICE_NO_PROMPT=1. LUKE_VOICE_PAUSE=1 waits for Enter before closing.
# One line, from Windows+R or PowerShell:
#   powershell -c "$env:LUKE_VOICE_PAUSE=1; irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall-luke-voice-windows.cmd | iex"
$ErrorActionPreference = 'Stop'
$Plugin = 'luke-voice@luke-voice'
$LvHome = if ($env:LUKE_VOICE_HOME) { $env:LUKE_VOICE_HOME } else { Join-Path $HOME '.luke-voice' }
$Port = if ($env:LUKE_VOICE_PORT) { $env:LUKE_VOICE_PORT } else { '4848' }

function Pause-IfAsked { if ($env:LUKE_VOICE_PAUSE -eq '1') { Write-Host ''; Read-Host '  Aperte Enter para fechar' | Out-Null } }
function Step($n, $text) { Write-Host ""; Write-Host "[$n/4] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "      OK  $text" -ForegroundColor Green }
function Fail($text, $help) {
  Write-Host ""
  Write-Host "  A desinstalação parou: $text" -ForegroundColor Red
  if ($help) { Write-Host "  O que fazer: $help" -ForegroundColor Yellow }
  Pause-IfAsked
  exit 1
}
trap { Fail "algo inesperado aconteceu: $($_.Exception.Message)" 'Feche o Claude Code e rode o desinstalador de novo.' }

# Only luke-voice's own folder is ever deleted.
$full = [IO.Path]::GetFullPath($LvHome).TrimEnd('\')
if (-not $full -or $full -eq [IO.Path]::GetFullPath($HOME).TrimEnd('\') -or $full.Length -le 3) {
  Fail "a pasta '$LvHome' não parece ser a do luke-voice." 'Confira a variável LUKE_VOICE_HOME.'
}

Write-Host ""
Write-Host "  Desinstalador do luke-voice" -ForegroundColor White
Write-Host "  Remove o luke-voice do Claude Code e apaga a pasta $LvHome"
Write-Host "  (a voz baixada, e o Node.js e o Git que o instalador trouxe). O resto do computador não muda."
if ($env:LUKE_VOICE_NO_PROMPT -ne '1') {
  $answer = (Read-Host '  Continuar? Enter para sim, n para não').Trim().ToLower()
  if ($answer -eq 'n' -or $answer -eq 'nao' -or $answer -eq 'não') { Write-Host '  Nada foi removido.'; Pause-IfAsked; exit 0 }
}

Step 1 'Parando a Ceci'
$hubFile = Join-Path $LvHome 'hub.json'
if (Test-Path $hubFile) {
  try {
    $token = (Get-Content $hubFile -Raw | ConvertFrom-Json).serviceToken
    Invoke-RestMethod -Method Post "http://127.0.0.1:$Port/shutdown" -Headers @{ authorization = "Bearer $token" } -TimeoutSec 5 | Out-Null
    Start-Sleep -Seconds 2
  } catch {
    # No hub running.
  }
}
# What could still hold files in the folder: the voice engine and the call window.
$like = "*$full*"
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like $like -or $_.CommandLine -like "*$full\chrome*" } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Ok 'A Ceci está parada.'

Step 2 'Removendo o luke-voice do Claude Code'
if (Get-Command claude -ErrorAction SilentlyContinue) {
  $ErrorActionPreference = 'Continue'
  & claude plugin uninstall $Plugin 2>&1 | Out-Null
  & claude plugin marketplace remove luke-voice 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  Ok 'Removido do Claude Code.'
} else {
  Ok 'O Claude Code não está neste computador: nada a remover nele.'
}

Step 3 'Tirando o Node.js e o Git do luke-voice do PATH'
# Before the folder goes: a short (8.3) and a long spelling of the same folder are matched while
# it still exists to be resolved.
$roots = @($LvHome.TrimEnd('\'), $full) | Select-Object -Unique
function Is-Ours($entry) {
  $forms = @($entry.TrimEnd('\'))
  try { $forms += [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($entry)).TrimEnd('\') } catch { }
  foreach ($form in $forms) { foreach ($root in $roots) { if ($form.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $true } } }
  return $false
}
$key = Get-Item 'HKCU:\Environment'
$userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$kept = @($userPath -split ';' | Where-Object { $_ -and -not (Is-Ours $_) })
$next = $kept -join ';'
if ($next -ne $userPath) {
  Set-ItemProperty 'HKCU:\Environment' -Name Path -Value $next -Type ExpandString
  [Environment]::SetEnvironmentVariable('LUKE_VOICE_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('LUKE_VOICE_PATH_CHANGED', $null, 'User')
}
Ok 'PATH limpo.'

Step 4 'Apagando a pasta do luke-voice'
if (Test-Path $full) {
  for ($try = 1; $try -le 3 -and (Test-Path $full); $try++) {
    Remove-Item -Recurse -Force $full -ErrorAction SilentlyContinue
    if (Test-Path $full) { Start-Sleep -Seconds 2 }
  }
  if (Test-Path $full) { Fail "não consegui apagar tudo em $full." 'Feche o Claude Code e a janela da chamada, e rode o desinstalador de novo.' }
}
Ok 'Pasta apagada.'

Write-Host ""
Write-Host "  ======================================" -ForegroundColor Green
Write-Host "   luke-voice removido." -ForegroundColor Green
Write-Host "  ======================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Feche o Claude Code, se estiver aberto, e abra de novo."
Write-Host "  Para instalar de novo um dia: https://github.com/lukeware-hub/luke-voice"
Pause-IfAsked
