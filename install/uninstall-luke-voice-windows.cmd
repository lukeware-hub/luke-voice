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
# Claude Code is closed first: while it is open, the mod would start the hub again, and the hub
# would make the folder again (and could download the voice again).
# Without questions: set LUKE_VOICE_NO_PROMPT=1. The window waits for Enter before closing when it
# would close by itself; LUKE_VOICE_PAUSE=1 always waits, LUKE_VOICE_PAUSE=0 never does.
# One line, from Windows+R or PowerShell (no $ inside the quotes, so PowerShell leaves it alone):
#   powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/uninstall-luke-voice-windows.cmd | iex"
$ErrorActionPreference = 'Stop'
$Plugin = 'luke-voice@luke-voice'
$LvHome = if ($env:LUKE_VOICE_HOME) { $env:LUKE_VOICE_HOME } else { Join-Path $HOME '.luke-voice' }
$Port = if ($env:LUKE_VOICE_PORT) { $env:LUKE_VOICE_PORT } else { '4848' }
# A person can answer: not with LUKE_VOICE_NO_PROMPT=1, and not when the input is a pipe or a file.
$CanAsk = $env:LUKE_VOICE_NO_PROMPT -ne '1' -and -not [Console]::IsInputRedirected

# Whether this window closes by itself at the end (started from Windows+R, a shortcut or Explorer).
# Double-clicked, the batch part above pauses on its own.
function Test-ClosesAlone {
  if ($env:LUKE_VOICE_PAUSE -eq '1') { return $true }
  if ($env:LUKE_VOICE_PAUSE -eq '0' -or $env:LUKE_VOICE_SELF -or -not $CanAsk) { return $false }
  try {
    $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId"
    return (-not $parent) -or $parent.Name -eq 'explorer.exe'
  } catch {
    return $false
  }
}
$PauseAtEnd = Test-ClosesAlone
function Pause-IfAsked { if ($PauseAtEnd) { Write-Host ''; Read-Host '  Aperte Enter para fechar' | Out-Null } }
function Ask($question) { if (-not $CanAsk) { return '' }; return ([string](Read-Host $question)).Trim().ToLower() }
function Step($n, $text) { Write-Host ""; Write-Host "[$n/4] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "      OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "      $text" -ForegroundColor Yellow }
function Fail($text, $help) {
  Write-Host ""
  Write-Host "  A desinstalação parou: $text" -ForegroundColor Red
  if ($help) { Write-Host "  O que fazer: $help" -ForegroundColor Yellow }
  Pause-IfAsked
  exit 1
}
# claude as a program (claude.exe or npm's claude.cmd), never npm's claude.ps1, which a computer
# that blocks scripts refuses to run; also where the installers put it.
function Find-Claude {
  $candidates = @(Get-Command claude -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  $profileDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  if ($profileDir) { $candidates += Join-Path $profileDir '.local\bin\claude.exe' }
  if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA 'npm\claude.cmd' }
  $found = @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
  foreach ($ext in @('.exe', '.cmd', '.bat')) {
    $hit = $found | Where-Object { $_.EndsWith($ext, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($hit) { return [string]$hit }
  }
  return $null
}
# Runs claude: stdout (JSON to read) and stderr (the error text) apart, and the exit code.
function Invoke-Claude([string[]]$CliArgs) {
  $ErrorActionPreference = 'Continue'
  $errLines = New-Object System.Collections.Generic.List[string]
  $outLines = & $Claude @CliArgs 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $errLines.Add("$_") } else { "$_" } }
  return @{ out = (@($outLines) -join "`n"); err = ($errLines -join "`n"); code = $LASTEXITCODE }
}
function Why($r) { if ($r.err.Trim()) { return $r.err.Trim() } else { return $r.out.Trim() } }
# Claude Code running: its own claude.exe (not the Claude desktop app, which is also claude.exe), or
# npm's (node ...\@anthropic-ai\claude-code\...).
function Get-ClaudeCode {
  @(Get-CimInstance Win32_Process | Where-Object {
      ($_.Name -eq 'claude.exe' -and "$($_.ExecutablePath)" -notmatch 'AnthropicClaude|WindowsApps') -or
      ($_.Name -eq 'node.exe' -and "$($_.CommandLine)" -match '@anthropic-ai[\\/]claude-code')
    })
}
# What runs from luke-voice: the hub (node ...\luke-voice\...\hub\server.mjs) and its guard, and
# anything started from the folder: the voice engine (llama-server), the call window's Chrome
# profile. luke-voice's own Node.js counts only while it runs the hub: once on the PATH it also runs
# the user's own scripts, which are left alone.
function Get-Ceci {
  @(Get-CimInstance Win32_Process | Where-Object {
      ($_.Name -eq 'node.exe' -and "$($_.CommandLine)" -match 'luke-voice.*hub[\\/](server|guard)\.mjs') -or
      ("$($_.ExecutablePath)" -like "$full\*" -and "$($_.ExecutablePath)" -notlike "$full\node\*") -or
      ("$($_.CommandLine)" -like "*$full\chrome*")
    })
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
$answer = Ask '  Continuar? Enter para sim, n para não'
if (@('n', 'nao', 'não') -contains $answer) { Write-Host '  Nada foi removido.'; Pause-IfAsked; exit 0 }

# With Claude Code open, the mod starts the hub again right after it stops.
$claudeOpen = @(Get-ClaudeCode).Count -gt 0
if ($claudeOpen) {
  if ($CanAsk) {
    while (@(Get-ClaudeCode).Count -gt 0) {
      Write-Host ""
      Write-Host "  O Claude Code está aberto: ele ligaria a Ceci de novo durante a remoção." -ForegroundColor Yellow
      $answer = Ask '  Feche todas as janelas do Claude Code e aperte Enter (c continua assim mesmo, n cancela)'
      if (@('n', 'nao', 'não') -contains $answer) { Write-Host '  Nada foi removido.'; Pause-IfAsked; exit 0 }
      if ($answer -eq 'c') { break }
    }
    $claudeOpen = @(Get-ClaudeCode).Count -gt 0
  } else {
    Write-Host "  Aviso: o Claude Code está aberto. Feche e abra de novo no fim, ou ele pode ligar a Ceci e baixar a voz outra vez." -ForegroundColor Yellow
  }
}

Step 1 'Parando a Ceci'
$hubFile = Join-Path $LvHome 'hub.json'
if (Test-Path $hubFile) {
  try {
    $token = (Get-Content $hubFile -Raw | ConvertFrom-Json).serviceToken
    Invoke-RestMethod -Method Post "http://127.0.0.1:$Port/shutdown" -Headers @{ authorization = "Bearer $token" } -TimeoutSec 5 | Out-Null
    Start-Sleep -Seconds 2
  } catch {
    # No hub answered: it is stopped by its command line below.
  }
}
Get-Ceci | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
$left = @(Get-Ceci | Where-Object { "$($_.CommandLine)" -match 'hub[\\/]server\.mjs|llama-server' })
if ($left.Count -eq 0) {
  Ok 'A Ceci está parada.'
} elseif ($claudeOpen) {
  # An open Claude Code started it again: said, not hidden; the rest still runs.
  Warn 'A Ceci voltou a rodar porque o Claude Code está aberto.'
} else {
  Fail 'a Ceci ainda está rodando.' 'Feche o Claude Code e a janela da chamada, e rode o desinstalador de novo.'
}

Step 2 'Removendo o luke-voice do Claude Code'
$Claude = Find-Claude
if ($Claude) {
  # Each removal is checked: only what is there is removed, and one that fails stops here.
  $r = Invoke-Claude @('plugin', 'list', '--json')
  if ($r.code -ne 0) { Fail 'não consegui ler os plugins do Claude Code.' (Why $r) }
  if (@($r.out | ConvertFrom-Json) | Where-Object { $_.id -eq $Plugin }) {
    $r = Invoke-Claude @('plugin', 'uninstall', $Plugin)
    if ($r.code -ne 0) { Fail 'não consegui remover o luke-voice do Claude Code.' "$(Why $r) Feche o Claude Code e rode o desinstalador de novo." }
  }
  $r = Invoke-Claude @('plugin', 'marketplace', 'list', '--json')
  if ($r.code -ne 0) { Fail 'não consegui ler as origens de plugins do Claude Code.' (Why $r) }
  if (@($r.out | ConvertFrom-Json) | Where-Object { $_.name -eq 'luke-voice' }) {
    $r = Invoke-Claude @('plugin', 'marketplace', 'remove', 'luke-voice')
    if ($r.code -ne 0) { Fail 'não consegui remover a origem do luke-voice do Claude Code.' "$(Why $r) Rode o desinstalador de novo." }
  }
  # `claude plugin uninstall` leaves the plugin's downloaded copy behind: only luke-voice's own
  # folder in Claude Code's plugin cache is deleted.
  $claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
  $pluginCache = Join-Path $claudeDir 'plugins\cache\luke-voice'
  if (Test-Path -LiteralPath $pluginCache) {
    Remove-Item -LiteralPath $pluginCache -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $pluginCache) { Fail "não consegui apagar $pluginCache." 'Feche o Claude Code e rode o desinstalador de novo.' }
  }
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
  # The folder itself or a folder inside it: a sibling such as .luke-voice-old is not ours.
  foreach ($form in $forms) { foreach ($root in $roots) { if ($form -eq $root -or $form.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) { return $true } } }
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
    # A hub an open Claude Code started again holds files in the folder.
    Get-Ceci | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $full -ErrorAction SilentlyContinue
    if (Test-Path $full) { Start-Sleep -Seconds 2 }
  }
  if (Test-Path $full) { Fail "não consegui apagar tudo em $full." 'Feche o Claude Code e a janela da chamada, e rode o desinstalador de novo.' }
}
Ok 'Pasta apagada.'

# Ceci's memory lives apart (it is never removed on its own): asked about here. With no one to ask,
# it is kept unless LUKE_VOICE_DELETE_MEMORY=1.
$memoryHome = if ($env:CECI_MEMORY_HOME) { $env:CECI_MEMORY_HOME } else { Join-Path $HOME '.ceci' }
if (Test-Path $memoryHome) {
  $memoryFull = [IO.Path]::GetFullPath($memoryHome).TrimEnd('\')
  if ($memoryFull -eq [IO.Path]::GetFullPath($HOME).TrimEnd('\') -or $memoryFull.Length -le 3) {
    Fail "a pasta '$memoryHome' não parece ser a da memória da Ceci." 'Confira a variável CECI_MEMORY_HOME.'
  }
  $deleteMemory = $env:LUKE_VOICE_DELETE_MEMORY -eq '1'
  if (-not $deleteMemory -and -not $env:LUKE_VOICE_DELETE_MEMORY) {
    Write-Host ""
    Write-Host "  A memória da Ceci (todas as conversas) está em $memoryFull."
    $answer = Ask '  Apagar a memória também? Não dá para desfazer. s para apagar, Enter para manter'
    $deleteMemory = @('s', 'sim', 'y', 'yes') -contains $answer
  }
  if ($deleteMemory) {
    Remove-Item -Recurse -Force $memoryFull -ErrorAction SilentlyContinue
    if (Test-Path $memoryFull) { Fail "não consegui apagar $memoryFull." 'Feche o Claude Code e rode o desinstalador de novo.' }
    Ok 'Memória da Ceci apagada.'
  } else {
    Ok "Memória da Ceci mantida em $memoryFull (para apagar depois, apague essa pasta)."
  }
}

Write-Host ""
Write-Host "  ======================================" -ForegroundColor Green
Write-Host "   luke-voice removido." -ForegroundColor Green
Write-Host "  ======================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Feche o Claude Code, se estiver aberto, e abra de novo."
if ($claudeOpen) {
  Write-Host "  O Claude Code estava aberto: se a pasta $LvHome voltar, feche o Claude Code e rode o desinstalador de novo." -ForegroundColor Yellow
}
Write-Host "  Para instalar de novo um dia: https://github.com/lukeware-hub/luke-voice"
Pause-IfAsked
