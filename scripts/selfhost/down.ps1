<#
.SYNOPSIS
  Stops the Cloudflare quick tunnel and the game server started by up.ps1. The database and its data are kept.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\selfhost\down.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
$pidFile = Join-Path $root '.selfhost\cloudflared.pid'

if (Test-Path $pidFile) {
  $tunnelPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($tunnelPid) { Stop-Process -Id $tunnelPid -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -Force
  Write-Host 'Tunnel stopped.'
} else {
  Write-Host 'No tunnel started by up.ps1 is running.'
}
docker compose stop server
if ($LASTEXITCODE -ne 0) { throw "docker compose stop failed (exit code $LASTEXITCODE)" }
Write-Host 'Server stopped. The database keeps running; stop it with: docker compose stop db'
