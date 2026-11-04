<#
.SYNOPSIS
  Starts the self-hosted game behind a Cloudflare quick tunnel (Windows / PowerShell).

.DESCRIPTION
  1. Optionally updates the code and rebuilds the image (-Update), then runs migrations.
  2. Starts `cloudflared` in the background and waits for its https://<random>.trycloudflare.com URL.
  3. Writes TRUST_PROXY and ALLOWED_ORIGINS into .env (other lines are kept).
  4. (Re)creates the server container, with the staging overlay and debug panel if -Staging is given.
  5. Waits until /health/ready answers and prints the URL to open on the phone.
  Stop everything with scripts/selfhost/down.ps1. See docs/ops/self-host-tunnel.md.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\selfhost\up.ps1 -Staging
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\selfhost\up.ps1 -Update -Staging
#>
param(
  [switch]$Staging,
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
$stateDir = Join-Path $root '.selfhost'
$log = Join-Path $stateDir 'cloudflared.log'
$pidFile = Join-Path $stateDir 'cloudflared.pid'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Invoke-Checked([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

foreach ($tool in 'docker', 'cloudflared') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed or not on PATH (see docs/ops/self-host-tunnel.md)" }
}

$composeFiles = @('-f', 'compose.yaml')
if ($Staging) { $composeFiles += @('-f', 'compose.staging.yaml') }

if ($Update) {
  Invoke-Checked 'git pull' { git pull --ff-only }
}
$imageMissing = -not (docker image ls -q idle-rpg-server:local)
if ($Update -or $imageMissing) {
  Invoke-Checked 'docker build' { docker compose build server }
}
Invoke-Checked 'database start' { docker compose up -d db }
Invoke-Checked 'migrations' { docker compose --profile ops run --rm migrate }

# Stop a tunnel left over from a previous run (its URL is dead once it stops anyway).
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -Force
}
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host 'Starting the Cloudflare quick tunnel...'
$tunnel = Start-Process -FilePath 'cloudflared' -PassThru -WindowStyle Hidden `
  -ArgumentList @('tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3000', '--logfile', $log)
Set-Content -Path $pidFile -Value $tunnel.Id

$url = $null
$deadline = (Get-Date).AddSeconds(60)
while (-not $url -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if ($tunnel.HasExited) { throw "cloudflared exited early; see $log" }
  if (Test-Path $log) {
    $found = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -First 1
    if ($found) { $url = $found.Matches[0].Value }
  }
}
if (-not $url) { throw "No tunnel URL after 60 s; see $log" }

# Keep any other settings in .env and replace only the two tunnel keys.
$envFile = Join-Path $root '.env'
$lines = @()
if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^(TRUST_PROXY|ALLOWED_ORIGINS)=' }) }
$lines += 'TRUST_PROXY=loopback,uniquelocal'
$lines += "ALLOWED_ORIGINS=$url"
# Compose reads .env; write it without a BOM so the first key is parsed correctly.
[System.IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))

Invoke-Checked 'server start' { docker compose @composeFiles up -d server }

Write-Host 'Waiting for the server to be ready...'
$ready = $false
$deadline = (Get-Date).AddSeconds(120)
while (-not $ready -and (Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health/ready' -UseBasicParsing -TimeoutSec 3
    $ready = $response.StatusCode -eq 200
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) { throw 'Server not ready after 120 s; check: docker compose logs server' }

Write-Host ''
Write-Host "Ready. Open on the phone: $url" -ForegroundColor Green
if ($Staging) { Write-Host 'Staging mode: the debug panel is enabled. Keep the URL private.' -ForegroundColor Yellow }
Write-Host 'The URL changes every time the tunnel restarts (a new URL means a new guest account on the phone).'
Write-Host 'Stop everything with: powershell -ExecutionPolicy Bypass -File scripts\selfhost\down.ps1'
