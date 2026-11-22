<# : batch part. Double-click this file to install luke-voice. The rest of the file is PowerShell.
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

# luke-voice installer for Windows. It installs Node.js when it is missing or too old, installs the
# luke-voice mod into Claude Code, lets you pick Ceci's voice (free local, or ElevenLabs with your
# key), downloads the free voice, and leaves the first call to start by itself when Claude Code opens.
# It speaks Brazilian Portuguese: that is who it is for.
# Without questions: set LUKE_VOICE_PROVIDER=local|elevenlabs and LUKE_VOICE_NO_PROMPT=1.
# The free voice is downloaded here: set LUKE_VOICE_PROFILE=gpu|light to force the natural voice on
# the GPU or the light browser voice instead of detecting it.
# set LUKE_VOICE_REF=<branch or tag> installs that version instead of main (to test a change).
# One line, from Windows+R or PowerShell, with no download. It has no $ in it: typed in PowerShell,
# a $env:... inside the quotes would be expanded by that PowerShell first and break the line.
#   powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lukeware-hub/luke-voice/main/install/install-luke-voice-windows.cmd | iex"
# The window waits for Enter before closing when it would close by itself (started from Windows+R or
# a shortcut). LUKE_VOICE_PAUSE=1 always waits, LUKE_VOICE_PAUSE=0 never does.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1's progress bar slows downloads many times over.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Plugin = 'luke-voice@luke-voice'
$Repo = 'lukeware-hub/luke-voice'
$Ref = "$env:LUKE_VOICE_REF".Trim()
$Source = if ($Ref) { "$Repo#$Ref" } else { $Repo }
$LvHome = if ($env:LUKE_VOICE_HOME) { $env:LUKE_VOICE_HOME } else { Join-Path $HOME '.luke-voice' }
# Node.js, when it is missing or older than 20: the official build, pinned by sha256, unpacked for
# this user only (no administrator, no password) into luke-voice's folder. The mod runs it from there.
$NodeVersion = 'v24.22.3'
$NodeSha256 = @{
  'win-x64'   = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
  'win-arm64' = 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14'
}
# Git, when it is missing: Claude Code clones the luke-voice marketplace with it. MinGit, Git for
# Windows' own portable build, pinned by sha256, the same way.
$GitVersion = '2.56.1'
$GitTag = 'v2.56.1.windows.1'
$GitSha256 = @{
  '64-bit' = '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd'
  'arm64'  = '96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c'
}
# A person can answer: not a run with LUKE_VOICE_NO_PROMPT=1, and not one whose input is a pipe or a
# file (Read-Host would get nothing back and stop the install).
$CanAsk = $env:LUKE_VOICE_NO_PROMPT -ne '1' -and -not [Console]::IsInputRedirected

# Whether this window closes by itself at the end: PowerShell started from Windows+R, a shortcut or
# Explorer (its parent is explorer.exe), not from a terminal that stays open. Double-clicked, the
# batch part above pauses on its own.
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
# claude as a program: claude.exe (Claude Code's own installer) or npm's claude.cmd, never npm's
# claude.ps1, which a computer that blocks scripts (Restricted policy) refuses to run. Also where
# the installers put it, for a window opened before it was on the PATH.
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
# Runs claude and returns what it wrote to stdout (which may be JSON to read), what it wrote to
# stderr (for the error message only) and its exit code. Windows PowerShell 5.1 turns any stderr
# line of a program into an error, which 'Stop' would make fatal: here it is only kept apart.
function Invoke-Claude([string[]]$CliArgs) {
  $ErrorActionPreference = 'Continue'
  $errLines = New-Object System.Collections.Generic.List[string]
  $outLines = & $Claude @CliArgs 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $errLines.Add("$_") } else { "$_" } }
  return @{ out = (@($outLines) -join "`n"); err = ($errLines -join "`n"); code = $LASTEXITCODE }
}
function Run-Claude([string[]]$CliArgs) {
  $r = Invoke-Claude $CliArgs
  if ($r.code -ne 0) {
    $why = if ($r.err.Trim()) { $r.err.Trim() } else { $r.out.Trim() }
    Fail "o comando 'claude $($CliArgs -join ' ')' falhou." $why
  }
  return $r.out
}
# With .NET, not Get-FileHash: Windows PowerShell started from PowerShell 7 can miss that cmdlet.
function Get-Sha256($file) {
  $stream = [IO.File]::OpenRead($file)
  try { return (([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $stream.Dispose() }
}
function Node-Major {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try { return [int](& node -p "process.versions.node.split('.')[0]") } catch { return 0 }
}
# Whether this Node.js downloads through a proxy set in HTTPS_PROXY (NODE_USE_ENV_PROXY: 22.21+, 24+).
function Node-ReadsProxy {
  try { return [string](& node -p "const [a, b] = process.versions.node.split('.').map(Number); a >= 24 || (a === 22 && b >= 21)") -eq 'true' } catch { return $false }
}
# The proxy downloads go through: HTTPS_PROXY or HTTP_PROXY when set, else the one Windows uses
# (Settings > Network > Proxy, or a company's automatic script). '' when there is none.
function Get-EnvProxy { foreach ($name in @('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')) { $v = [Environment]::GetEnvironmentVariable($name); if ($v -and $v.Trim()) { return $v.Trim() } }; return '' }
function Get-SystemProxy {
  try {
    $target = [Uri]'https://huggingface.co/'
    $proxy = [Net.WebRequest]::GetSystemWebProxy()
    if ($proxy.IsBypassed($target)) { return '' }
    $at = $proxy.GetProxy($target)
    if ($at -and $at.Host -ne $target.Host) { return "http://$($at.Authority)" }
  } catch { }
  return ''
}
function Has-Git {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
  $ErrorActionPreference = 'Continue'
  & git --version 2>&1 | Out-Null
  return $LASTEXITCODE -eq 0
}
# Downloads a zip, checks its sha256 and unpacks it into $dir (replacing it). $inner is the folder
# inside the zip that becomes $dir, or '' when the zip's root does.
function Get-Portable($label, $url, $sha256, $inner, $dir, $help) {
  $zip = Join-Path $env:TEMP ([IO.Path]::GetFileName($url))
  try {
    Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
  } catch {
    Fail "não consegui baixar o $label." "Confira a internet. $help"
  }
  if ((Get-Sha256 $zip) -ne $sha256) {
    Remove-Item -Force $zip
    Fail "o $label baixado não passou na conferência de segurança." "Rode o instalador de novo. Se repetir: $help"
  }
  $unpack = "$dir-unpack"
  Remove-Item -Recurse -Force $unpack, $dir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $unpack | Out-Null
  # tar.exe (Windows 10 and 11) is much faster than Expand-Archive on thousands of files.
  $ErrorActionPreference = 'Continue'
  & tar.exe -xf $zip -C $unpack 2>&1 | Out-Null
  $isUnpacked = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  if (-not $isUnpacked) { Expand-Archive $zip -DestinationPath $unpack -Force }
  if ($inner) { Move-Item (Join-Path $unpack $inner) $dir; Remove-Item -Recurse -Force $unpack } else { Move-Item $unpack $dir }
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
}
# Puts $dir first on this user's PATH, now and for windows opened from now on. The PATH is kept as
# written (%VARIABLES% stay unexpanded).
function Add-UserPath($dir) {
  $userPath = [string](Get-Item 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  if (($userPath -split ';') -notcontains $dir) {
    $next = if ($userPath) { "$dir;$userPath" } else { $dir }
    Set-ItemProperty 'HKCU:\Environment' -Name Path -Value $next -Type ExpandString
    # Tells Windows the environment changed, so programs opened from now on see it.
    [Environment]::SetEnvironmentVariable('LUKE_VOICE_PATH_CHANGED', '1', 'User')
    [Environment]::SetEnvironmentVariable('LUKE_VOICE_PATH_CHANGED', $null, 'User')
  }
  $env:Path = "$dir;$env:Path"
}
# Downloads Node.js into luke-voice's folder and puts it first on this run's PATH. -ForUser also
# puts it on the user's PATH (only when this computer had no Node.js: an older one stays as it was,
# and the mod finds luke-voice's own by itself).
function Install-Node([switch]$ForUser) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
  $name = "node-$NodeVersion-$arch"
  $dir = Join-Path $LvHome 'node'
  Get-Portable 'Node.js' "https://nodejs.org/dist/$NodeVersion/$name.zip" $NodeSha256[$arch] $name $dir 'instale a versão LTS em https://nodejs.org.'
  if ($ForUser) { Add-UserPath $dir } else { $env:Path = "$dir;$env:Path" }
}
function Install-Git {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { '64-bit' }
  $dir = Join-Path $LvHome 'git'
  Get-Portable 'Git' "https://github.com/git-for-windows/git/releases/download/$GitTag/MinGit-$GitVersion-$arch.zip" $GitSha256[$arch] '' $dir 'instale o Git em https://git-scm.com.'
  Add-UserPath (Join-Path $dir 'cmd')
}
# Anything unexpected still ends with a message a person can act on, not a red stack trace.
trap { Fail "algo inesperado aconteceu: $($_.Exception.Message)" 'Rode o instalador de novo. Se repetir, tire uma foto desta tela e abra um aviso em https://github.com/lukeware-hub/luke-voice/issues.' }

Write-Host ""
Write-Host "  Instalador do luke-voice" -ForegroundColor White
Write-Host "  Ceci, a assistente de voz do Claude Code. Leva alguns minutos."

Step 1 'Procurando o Claude Code'
$Claude = Find-Claude
if (-not $Claude) {
  Fail 'o Claude Code não foi encontrado neste computador.' 'Instale em https://claude.com/claude-code e entre na sua conta uma vez. Se acabou de instalar, feche e abra esta janela.'
}
Ok "Claude Code encontrado ($Claude)."

Step 2 'Preparando o Node.js e o Git'
$installedTools = $false
# The proxy of this computer, if any: Node.js only downloads through it from 22.21 and 24 on.
$envProxy = Get-EnvProxy
$proxyAt = if ($envProxy) { $envProxy } else { Get-SystemProxy }
function Needs-OwnNode { $m = Node-Major; return $m -lt 20 -or ($proxyAt -and -not (Node-ReadsProxy)) }
# Ones this installer put here before are used even if this window does not see them yet.
$ownNode = Join-Path $LvHome 'node'
if ((Needs-OwnNode) -and (Test-Path (Join-Path $ownNode 'node.exe'))) {
  if ((Node-Major) -eq 0) { Add-UserPath $ownNode } else { $env:Path = "$ownNode;$env:Path" }
}
$ownGit = Join-Path $LvHome 'git\cmd'
if (-not (Has-Git) -and (Test-Path (Join-Path $ownGit 'git.exe'))) { Add-UserPath $ownGit }
$major = Node-Major
# An old Node.js counts as a missing one: a current one goes into luke-voice's folder, without
# administrator, and the old one stays as it was.
if ($major -eq 0) {
  Say "      O Node.js não está instalado. Instalando o Node.js $NodeVersion só para você (cerca de 30 MB)..."
  Install-Node -ForUser
  $installedTools = $true
} elseif ($major -lt 20) {
  Say "      O Node.js $major deste computador é antigo (o luke-voice precisa do 20 ou mais novo)."
  Say "      Instalando o Node.js $NodeVersion só para o luke-voice, sem mexer no seu (cerca de 30 MB)..."
  Install-Node
} elseif ($proxyAt -and -not (Node-ReadsProxy)) {
  Say "      Este computador usa o proxy $proxyAt, e o Node.js $major não baixa por ele."
  Say "      Instalando o Node.js $NodeVersion só para o luke-voice, sem mexer no seu (cerca de 30 MB)..."
  Install-Node
}
$major = Node-Major
if ($major -lt 20) { Fail 'o Node.js não funcionou depois de instalado.' 'Instale a versão LTS em https://nodejs.org.' }
Ok "Node.js $major pronto."
if (-not (Has-Git)) {
  Say "      O Git não está instalado (o Claude Code usa para baixar o luke-voice). Instalando o Git $GitVersion só para você (cerca de 40 MB)..."
  Install-Git
  $installedTools = $true
  if (-not (Has-Git)) { Fail 'o Git não funcionou depois de instalado.' 'Instale o Git em https://git-scm.com.' }
}
Ok 'Git pronto.'

Step 3 'Instalando o luke-voice no Claude Code'
# Claude Code keeps one source per marketplace: switching between main and a branch replaces it.
$r = Invoke-Claude @('plugin', 'marketplace', 'add', $Source)
$added = "$($r.out)`n$($r.err)".Trim()
if ($r.code -ne 0 -or $added -match 'Failed to add') {
  if ($added -match "source doesn't match") {
    Say "      Trocando a origem do luke-voice para $Source."
    Run-Claude @('plugin', 'marketplace', 'remove', 'luke-voice') | Out-Null
    Run-Claude @('plugin', 'marketplace', 'add', $Source) | Out-Null
  } else {
    Fail "o comando 'claude plugin marketplace add $Source' falhou." $added
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
$provider = [string]$env:LUKE_VOICE_PROVIDER
if (-not $provider -and $CanAsk) {
  Say '      Qual voz a Ceci deve usar?'
  Say '        Enter  Voz gratuita, no seu computador (recomendado). Sem conta e sem chave.'
  Say '        e      ElevenLabs. Paga por uso; precisa de uma chave da ElevenLabs.'
  $choice = ([string](Read-Host '      Escolha')).Trim().ToLower()
  $provider = if (@('e', 'eleven', 'elevenlabs') -contains $choice) { 'elevenlabs' } else { 'local' }
}
# No answer and no choice: keep the saved one; someone who already has a key stays on ElevenLabs.
if (-not $provider) {
  $provider = if ($current) { $current } elseif ($hasKey) { 'elevenlabs' } else { 'local' }
}
if (@('local', 'elevenlabs') -notcontains $provider) { Fail "LUKE_VOICE_PROVIDER precisa ser local ou elevenlabs, não '$provider'." }

$key = ''
if ($provider -eq 'elevenlabs' -and $CanAsk) {
  if ($hasKey) {
    Say '      Já existe uma chave da ElevenLabs salva. Aperte Enter para manter, ou cole uma chave nova.'
  } else {
    Say '      Pegue uma chave em https://elevenlabs.io/app/settings/api-keys (a conta grátis serve).'
    Say '      Cole aqui e aperte Enter. Ela fica escondida. Só Enter pula por enquanto.'
  }
  $secure = Read-Host '      Chave' -AsSecureString
  if ($secure) { $key = ([string][Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))).Trim() }
}
# The values go on stdin, never the command line. Options left out keep their saved values.
$values = @{ voice_provider = $provider }
if ($key) { $values.api_key = $key }
$json = $values | ConvertTo-Json -Compress
# On Windows, claude reads --values-stdin reliably only from a file (a pipe from PowerShell can
# reach it empty). The file is in the user's own temp folder, which only they can read, and is
# deleted right after. "call" keeps the quotes around claude's full path intact in cmd.
$valuesFile = Join-Path $env:TEMP ("luke-voice-" + [guid]::NewGuid().ToString('N') + '.json')
try {
  [IO.File]::WriteAllText($valuesFile, $json)
  $ErrorActionPreference = 'Continue'
  $out = & $env:ComSpec /d /c "call `"$Claude`" plugin configure $Plugin --values-stdin < `"$valuesFile`"" 2>&1 | ForEach-Object { "$_" } | Out-String
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
  Step 6 'Baixando a voz da Ceci (até 3,3 GB, só uma vez)'
  $setup = if ($entry.installPath) { Join-Path $entry.installPath 'hub\setup.mjs' } else { '' }
  if ($setup -and (Test-Path $setup)) {
    # Node.js does not read Windows' proxy settings: the proxy Windows uses goes to it in
    # HTTPS_PROXY, for this download only.
    $addedProxy = $false
    if ($proxyAt -and -not $envProxy) {
      $env:HTTPS_PROXY = $proxyAt; $env:HTTP_PROXY = $proxyAt; $addedProxy = $true
      Say "      Baixando pelo proxy do Windows ($proxyAt)."
    }
    # A line node writes to stderr must not stop the install ('Stop'): its exit code says how it went.
    $ErrorActionPreference = 'Continue'
    & node $setup
    $setupCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($addedProxy) { Remove-Item Env:HTTPS_PROXY, Env:HTTP_PROXY -ErrorAction SilentlyContinue }
    if ($setupCode -eq 0) {
      $voiceReady = $true
      Ok 'A voz da Ceci está pronta.'
    } elseif ($setupCode -eq 2) {
      Write-Host '      A voz não foi baixada: falta espaço no disco (veja a linha acima).' -ForegroundColor Yellow
      Write-Host '      O que fazer: libere espaço e rode o instalador de novo, ou digite /luke-voice setup no Claude Code.' -ForegroundColor Yellow
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
if ($installedTools) {
  Write-Host "   1. Feche o Claude Code, se estiver aberto, e também a janela do terminal onde ele roda."
  Write-Host "      Depois abra o Claude Code de novo (o Node.js ou o Git acabou de ser instalado)."
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
# The browsers the hub opens the call in as an app window (hub/server.mjs): Chrome, else Edge.
$browser = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Google\Chrome\Application\chrome.exe'; Join-Path $_ 'Microsoft\Edge\Application\msedge.exe' } | Where-Object { Test-Path $_ }
if (-not $browser) {
  Write-Host ""
  Write-Host "  Dica: instale o Google Chrome (https://www.google.com/chrome). A janela da chamada funciona melhor nele." -ForegroundColor Yellow
}
if ($provider -eq 'local' -and -not $voiceReady) {
  Write-Host ""
  Write-Host "  A primeira chamada termina de baixar a voz gratuita, só uma vez."
} elseif ($provider -eq 'elevenlabs' -and -not $hasKey) {
  Write-Host ""
  Write-Host "  A voz da ElevenLabs precisa de uma chave. Rode o instalador de novo para colocar, ou use a voz gratuita." -ForegroundColor Yellow
}
Pause-IfAsked
