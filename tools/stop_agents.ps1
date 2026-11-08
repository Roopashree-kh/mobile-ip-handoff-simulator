# Stops every simulator process (agents, gateway, Vite) that is still running.
$root = Split-Path -Parent $PSScriptRoot
$pattern = 'agents[\\/](core_router|home_agent|foreign_agent|mobile_node|correspondent)\.py|telemetry_tail\.py|gateway[\\/]server\.js|vite'
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -match '^(python|node)(\.exe)?$') -and $_.CommandLine -and
  ($_.CommandLine -like "*$root*" -or $_.CommandLine -match $pattern)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "stopped $($_.ProcessId) $($_.CommandLine)" }
