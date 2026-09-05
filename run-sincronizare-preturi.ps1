# run-sincronizare-preturi.ps1
# Wrapper pentru rulare programata (Windows Task Scheduler). Sincronizeaza
# cache-ul de preturi cu nomenclatorul de pe serverul recrutare-bot si scrie
# log-ul in output/logs/. Poate fi rulat si manual: .\run-sincronizare-preturi.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Asigura node in PATH (fallback la calea standard daca nu e).
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $nodeDir = 'C:\Program Files\nodejs'
  if (Test-Path (Join-Path $nodeDir 'node.exe')) { $env:Path = "$nodeDir;$env:Path" }
}

$logDir = Join-Path $root 'output\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$log = Join-Path $logDir "sincronizare-preturi_$stamp.log"

"[$(Get-Date -Format o)] START sincronizare preturi" | Out-File -FilePath $log -Encoding utf8
node scripts\sincronizeaza-preturi-server.js --scrie *>> $log
$code = $LASTEXITCODE
"[$(Get-Date -Format o)] EXIT $code" | Out-File -FilePath $log -Append -Encoding utf8
exit $code
