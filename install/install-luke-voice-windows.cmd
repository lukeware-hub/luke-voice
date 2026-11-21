<# : batch part. Double-click this file to install luke-voice. The rest of the file is PowerShell.
@echo off
setlocal
rem The path goes through the environment: a quote in it (C:\Users\O'Brien) would end a PowerShell string.
set "LUKE_VOICE_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText($env:LUKE_VOICE_SELF, [Text.Encoding]::UTF8); Invoke-Expression $s"
echo.
pause
exit /b
#>

# luke-voice installer for Windows. It installs Node.js when it is missing, installs the luke-voice
# mod into Claude Code, lets you pick Ceci's voice (free local, or ElevenLabs with your key),
# downloads the free voice, and leaves the first call to start by itself when Claude Code opens.
# It speaks Brazilian Portuguese: that is who it is for.
# Without questions: set LUKE_VOICE_PROVIDER=local|elevenlabs and LUKE_VOICE_NO_PROMPT=1.
# The free voice is downloaded here: set LUKE_VOICE_PROFILE=gpu|light to force the natural voice on
# the GPU or the light browser voice instead of detecting it.
# set LUKE_VOICE_REF=<branch or tag> installs that version instead of main (to test a change).
# LUKE_VOICE_PAUSE=1 waits for Enter before closing (the Windows+R line sets it).
# One line, from Windows+R or PowerShell, with no download:
#   powershell -c "$env:LUKE_VOICE_PAUSE=1; irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1's progress bar slows downloads many times over.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Plugin = 'luke-voice@luke-voice'
$Repo = 'lukeware-hub/luke-voice'
$Ref = "$env:LUKE_VOICE_REF".Trim()
$Source = if ($Ref) { "$Repo#$Ref" } else { $Repo }
$LvHome = if ($env:LUKE_VOICE_HOME) { $env:LUKE_VOICE_HOME } else { Join-Path $HOME '.luke-voice' }
# Node.js, when it is missing: the official build, pinned by sha256, unpacked for this user only
# (no administrator, no password) into luke-voice's folder.
$NodeVersion = 'v24.22.3'
$NodeSha256 = @{
  'win-x64'   = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
  'win-arm64' = 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14'
}

function Pause-IfAsked { if ($env:LUKE_VOICE_PAUSE -eq '1') { Write-Host ''; Read-Host '  Aperte Enter para fechar' | Out-Null } }
function Say($text) { Write-Host $text }
function Step($n, $text) { Write-Host ""; Write-Host "[$n/6] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "      OK  $text" -ForegroundColor Green }
function Fail($text, $help) {
  Write-Host ""
  Write-Host "  A instalação parou: $text" -ForegroundColor Red
  if ($help) { Write-Host "  O que fazer: $help" -ForegroundColor Yellow }
  Write-Host "  Depois, rode o instalador de novo." -ForegroundColor Yellow
  Pause-IfAsked
  exit 1
}
# Runs claude and returns its output and exit code. Windows PowerShell 5.1 turns any stderr line of
# a program into an error, which 'Stop' would make fatal: here stderr is just more output.
function Invoke-Claude([string[]]$CliArgs) {
  $ErrorActionPreference = 'Continue'
  $out = & claude @CliArgs 2>&1 | ForEach-Object { "$_" } | Out-String
  return @{ out = $out; code = $LASTEXITCODE }
}
function Run-Claude([string[]]$CliArgs) {
  $r = Invoke-Claude $CliArgs
  if ($r.code -ne 0) { Fail "o comando 'claude $($CliArgs -join ' ')' falhou." $r.out.Trim() }
  return $r.out
}
function Node-Major {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try { return [int](& node -p "process.versions.node.split('.')[0]") } catch { return 0 }
}
# Downloads Node.js into $LvHome\node and puts it on this user's PATH, now and for new windows.
function Install-Node {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
  $name = "node-$NodeVersion-$arch"
  $dir = Join-Path $LvHome 'node'
  $zip = Join-Path $env:TEMP "$name.zip"
  try {
    Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$name.zip" -OutFile $zip -UseBasicParsing
  } catch {
    Fail 'não consegui baixar o Node.js.' 'Confira a internet. Ou instale a versão LTS em https://nodejs.org.'
  }
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $NodeSha256[$arch]) {
    Remove-Item -Force $zip
    Fail 'o Node.js baixado não passou na conferência de segurança.' 'Rode o instalador de novo. Se repetir, instale a versão LTS em https://nodejs.org.'
  }
  $unpack = Join-Path $LvHome 'node-unpack'
  Remove-Item -Recurse -Force $unpack, $dir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $unpack | Out-Null
  # tar.exe (Windows 10 and 11) is much faster than Expand-Archive on Node's thousands of files.
  $ErrorActionPreference = 'Continue'
  & tar.exe -xf $zip -C $unpack 2>&1 | Out-Null
  $isUnpacked = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  if (-not $isUnpacked) { Expand-Archive $zip -DestinationPath $unpack -Force }
  Move-Item (Join-Path $unpack $name) $dir
  Remove-Item -Recurse -Force $unpack, $zip -ErrorAction SilentlyContinue
  # This user's PATH, kept as written (%VARIABLES% stay unexpanded), with Node.js added.
  $key = Get-Item 'HKCU:\Environment'
  $userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  if (($userPath -split ';') -notcontains $dir) {
    $next = if ($userPath) { "$dir;$userPath" } else { $dir }
    Set-ItemProperty 'HKCU:\Environment' -Name Path -Value $next -Type ExpandString
    # Tells Windows the environment changed, so windows opened from now on see Node.js.
    [Environment]::SetEnvironmentVariable('LUKE_VOICE_PATH_CHANGED', '1', 'User')
    [Environment]::SetEnvironmentVariable('LUKE_VOICE_PATH_CHANGED', $null, 'User')
  }
  $env:Path = "$dir;$env:Path"
}

Write-Host ""
Write-Host "  Instalador do luke-voice" -ForegroundColor White
Write-Host "  Ceci, a assistente de voz do Claude Code. Leva alguns minutos."

Step 1 'Procurando o Claude Code'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Fail 'o Claude Code não foi encontrado neste computador.' 'Instale em https://claude.com/claude-code e entre na sua conta uma vez.'
}
Ok 'Claude Code encontrado.'

Step 2 'Procurando o Node.js'
$installedNode = $false
# A Node.js this installer put here before is used even if this window does not see it yet.
$ownNode = Join-Path $LvHome 'node'
if ((Node-Major) -lt 20 -and (Test-Path (Join-Path $ownNode 'node.exe'))) { $env:Path = "$ownNode;$env:Path" }
$major = Node-Major
if ($major -eq 0) {
  Say "      O Node.js não está instalado. Instalando o Node.js $NodeVersion só para você (cerca de 30 MB)..."
  Install-Node
  $installedNode = $true
} elseif ($major -lt 20) {
  Fail "o Node.js $major é antigo demais (o luke-voice precisa do 20 ou mais novo)." 'Atualize para a versão LTS em https://nodejs.org.'
}
$major = Node-Major
if ($major -lt 20) { Fail 'o Node.js não funcionou depois de instalado.' 'Instale a versão LTS em https://nodejs.org.' }
Ok "Node.js $major pronto."

Step 3 'Instalando o luke-voice no Claude Code'
# Claude Code keeps one source per marketplace: switching between main and a branch replaces it.
$r = Invoke-Claude @('plugin', 'marketplace', 'add', $Source)
$added = $r.out
if ($r.code -ne 0 -or $added -match 'Failed to add') {
  if ($added -match "source doesn't match") {
    Say "      Trocando a origem do luke-voice para $Source."
    Run-Claude @('plugin', 'marketplace', 'remove', 'luke-voice') | Out-Null
    Run-Claude @('plugin', 'marketplace', 'add', $Source) | Out-Null
  } else {
    Fail "o comando 'claude plugin marketplace add $Source' falhou." $added.Trim()
  }
}
Run-Claude @('plugin', 'marketplace', 'update', 'luke-voice') | Out-Null
Run-Claude @('plugin', 'install', $Plugin) | Out-Null
Run-Claude @('plugin', 'update', $Plugin) | Out-Null
Ok 'luke-voice instalado.'

Step 4 'Escolhendo a voz da Ceci'
$config = Run-Claude @('plugin', 'configure', $Plugin, '--json') | ConvertFrom-Json
$hasKey = -not ($config.unconfigured -contains 'api_key')
$current = [string]$config.inputs.voice_provider
$canAsk = $env:LUKE_VOICE_NO_PROMPT -ne '1'
$provider = [string]$env:LUKE_VOICE_PROVIDER
if (-not $provider -and $canAsk) {
  Say '      Qual voz a Ceci deve usar?'
  Say '        Enter  Voz gratuita, no seu computador (recomendado). Sem conta e sem chave.'
  Say '        e      ElevenLabs. Paga por uso; precisa de uma chave da ElevenLabs.'
  $choice = (Read-Host '      Escolha').Trim().ToLower()
  $provider = if (@('e', 'eleven', 'elevenlabs') -contains $choice) { 'elevenlabs' } else { 'local' }
}
# No answer and no choice: keep the saved one; someone who already has a key stays on ElevenLabs.
if (-not $provider) {
  $provider = if ($current) { $current } elseif ($hasKey) { 'elevenlabs' } else { 'local' }
}
if (@('local', 'elevenlabs') -notcontains $provider) { Fail "LUKE_VOICE_PROVIDER precisa ser local ou elevenlabs, não '$provider'." }

$key = ''
if ($provider -eq 'elevenlabs' -and $canAsk) {
  if ($hasKey) {
    Say '      Já existe uma chave da ElevenLabs salva. Aperte Enter para manter, ou cole uma chave nova.'
  } else {
    Say '      Pegue uma chave em https://elevenlabs.io/app/settings/api-keys (a conta grátis serve).'
    Say '      Cole aqui e aperte Enter. Ela fica escondida. Só Enter pula por enquanto.'
  }
  $secure = Read-Host '      Chave' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
}
# The values go on stdin, never the command line. Options left out keep their saved values.
$values = @{ voice_provider = $provider }
if ($key) { $values.api_key = $key }
$json = $values | ConvertTo-Json -Compress
# On Windows, claude reads --values-stdin reliably only from a file (a pipe from PowerShell can
# reach it empty). The file is in the user's own temp folder, which only they can read, and is
# deleted right after.
$valuesFile = Join-Path $env:TEMP ("luke-voice-" + [guid]::NewGuid().ToString('N') + '.json')
try {
  [IO.File]::WriteAllText($valuesFile, $json)
  $ErrorActionPreference = 'Continue'
  $out = & $env:ComSpec /d /c "claude plugin configure $Plugin --values-stdin < `"$valuesFile`"" 2>&1 | ForEach-Object { "$_" } | Out-String
  $saved = $LASTEXITCODE -eq 0
} finally {
  $ErrorActionPreference = 'Stop'
  Remove-Item -Force -ErrorAction SilentlyContinue $valuesFile
}
$values = $null; $json = $null
if (-not $saved) { Fail 'não consegui salvar as configurações.' $out.Trim() }
if ($key) { $hasKey = $true }
$key = $null
if ($provider -eq 'local') {
  Ok 'Voz: gratuita, no seu computador.'
} else {
  Ok 'Voz: ElevenLabs.'
  if ($hasKey) { Ok 'Chave da ElevenLabs salva no cofre do Claude Code.' } else { Say '      Ainda sem chave. Rode o instalador de novo para colocar.' }
}

Step 5 'Conferindo a instalação'
$list = Run-Claude @('plugin', 'list', '--json') | ConvertFrom-Json
$entry = @($list) | Where-Object { $_.id -eq $Plugin } | Select-Object -First 1
if (-not $entry) { Fail 'o luke-voice não aparece na lista de plugins instalados.' 'Confira a internet.' }
if (-not $entry.enabled) {
  Run-Claude @('plugin', 'enable', $Plugin) | Out-Null
}
Ok "luke-voice $($entry.version) instalado e ativado."

$voiceReady = $false
if ($provider -eq 'local') {
  Step 6 'Baixando a voz da Ceci (até 3 GB, só uma vez)'
  $setup = if ($entry.installPath) { Join-Path $entry.installPath 'hub\setup.mjs' } else { '' }
  if ($setup -and (Test-Path $setup)) {
    & node $setup
    if ($LASTEXITCODE -eq 0) {
      $voiceReady = $true
      Ok 'A voz da Ceci está pronta.'
    } else {
      Write-Host '      A voz ainda não está pronta. A primeira chamada termina o download, ou digite /luke-voice setup no Claude Code.' -ForegroundColor Yellow
    }
  } else {
    Say '      Esta versão baixa a voz na primeira chamada.'
  }
} else {
  Step 6 'A voz da Ceci'
  Ok 'A ElevenLabs não precisa baixar nada.'
}

# The first Claude Code opened from now on turns luke-voice on and starts the call by itself.
$canCall = $provider -eq 'local' -or $hasKey
if ($canCall) {
  New-Item -ItemType Directory -Force $LvHome | Out-Null
  [IO.File]::WriteAllText((Join-Path $LvHome 'first-call'), "pending`n")
}

Write-Host ""
Write-Host "  ======================================" -ForegroundColor Green
Write-Host "   Instalação concluída: luke-voice $($entry.version)$(if ($Ref) { " (de $Ref)" })" -ForegroundColor Green
Write-Host "  ======================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Agora:"
if ($installedNode) {
  Write-Host "   1. Feche o Claude Code, se estiver aberto, e também a janela do terminal onde ele roda."
  Write-Host "      Depois abra o Claude Code de novo (o Node.js acabou de ser instalado)."
} else {
  Write-Host "   1. Feche o Claude Code, se estiver aberto, e abra de novo."
}
if ($canCall) {
  Write-Host "   2. A Ceci liga sozinha e abre a janela da chamada. É só falar com ela."
  Write-Host ""
  Write-Host "  Depois, para chamar a Ceci de novo, digite /luke-voice call no Claude Code."
} else {
  Write-Host "   2. Clique no botão 'luke-voice: off', acima de onde você digita, para ligar."
  Write-Host "   3. Digite /luke-voice call para falar com a Ceci."
}
Write-Host "  Para trocar a voz: /luke-voice voz local ou /luke-voice voz elevenlabs."
if ($provider -eq 'local' -and -not $voiceReady) {
  Write-Host ""
  Write-Host "  A primeira chamada termina de baixar a voz gratuita, só uma vez."
} elseif ($provider -eq 'elevenlabs' -and -not $hasKey) {
  Write-Host ""
  Write-Host "  A voz da ElevenLabs precisa de uma chave. Rode o instalador de novo para colocar, ou use a voz gratuita." -ForegroundColor Yellow
}
Pause-IfAsked
