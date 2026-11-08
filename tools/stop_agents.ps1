# Stops every simulator process started from this folder (agents, gateway, vite).
$root = Split-Path -Parent $PSScriptRoot
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -match '^(python|node)(\.exe)?$') -and $_.CommandLine -and
  ($_.CommandLine -like "*$root*" -or $_.CommandLine -match 'agents[\/](core_router|home_agent|foreign_agent|mobile_node|correspondent)\.py' -or $_.CommandLine -match 'telemetry_tail\.py')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped $($_.ProcessId) $($_.CommandLine)" }
