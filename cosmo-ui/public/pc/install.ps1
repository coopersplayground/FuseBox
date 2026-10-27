# Cosmo PC Agent installer - run once on the PC.
# Downloads the agent from the Fuse_Box box on the home network, installs it
# under the user profile, starts it at every logon, and starts it now.
# Safe to re-run: it stops the old agent first and picks up the newest
# version from the box.
$ErrorActionPreference = 'Stop'
$BoxUrl = 'http://192.168.1.10:3180'
$Dir = Join-Path $env:LOCALAPPDATA 'CosmoPC'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Agent = Join-Path $Dir 'agent.ps1'
Invoke-WebRequest -Uri "$BoxUrl/pc/agent.ps1" -OutFile $Agent -UseBasicParsing
Stop-ScheduledTask -TaskName 'CosmoPCAgent' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Agent`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'CosmoPCAgent' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'CosmoPCAgent'
Write-Host 'Cosmo PC Agent is installed and running. You can close this window.'
