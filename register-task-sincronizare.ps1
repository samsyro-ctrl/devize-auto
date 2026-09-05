# register-task-sincronizare.ps1
# Inregistreaza (sau actualizeaza) un task in Windows Task Scheduler care
# sincronizeaza ZILNIC preturile cu serverul recrutare-bot, la ora data.
# Rulare:
#   .\register-task-sincronizare.ps1                 # zilnic la 06:00
#   .\register-task-sincronizare.ps1 -Time 08:00
#   .\register-task-sincronizare.ps1 -Remove         # sterge task-ul
param(
  [string]$Time = '06:00',
  [string]$TaskName = 'DevizeAutoSincronizarePreturi',
  [switch]$Remove
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$wrapper = Join-Path $root 'run-sincronizare-preturi.ps1'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Task '$TaskName' sters (daca exista)."
  return
}

if (-not (Test-Path $wrapper)) { throw "Nu gasesc $wrapper" }

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'devize-auto: sincronizare zilnica a preturilor cu recrutare-bot (server)' -Force | Out-Null

Write-Host "✅ Task '$TaskName' inregistrat: ruleaza zilnic la $Time."
Write-Host "   Log-uri in: output\logs\   |   Sterge cu: .\register-task-sincronizare.ps1 -Remove"
