<#
.SYNOPSIS
  Starts the self-hosted game behind a Cloudflare tunnel (Windows / PowerShell).

.DESCRIPTION
  1. Optionally updates the code and rebuilds the image (-Update), then runs migrations.
  2. Starts `cloudflared` in the background and waits for its https://<random>.trycloudflare.com URL (quick tunnel),
     or, with -Hostname, runs a named tunnel on your own domain (stable URL; one-time setup in the docs).
  3. Writes TRUST_PROXY and ALLOWED_ORIGINS into .env (other lines are kept).
  4. (Re)creates the server container, with the staging overlay and debug panel if -Staging is given.
  5. Waits until /health/ready answers and prints the URL to open on the phone.
  Stop everything with scripts/selfhost/down.ps1. See docs/ops/self-host-tunnel.md.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\selfhost\up.ps1 -Staging
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\selfhost\up.ps1 -Update -Staging
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\selfhost\up.ps1 -Hostname game.example.com
#>
param(
  [switch]$Staging,
  [switch]$Update,
  [string]$Hostname = '',
  [string]$TunnelName = ''
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

# Named tunnel: resolve the tunnel and its credentials file before touching Docker, so a missing one-time setup fails fast.
$namedConfig = Join-Path $stateDir 'cloudflared-named.yml'
if ($Hostname) {
  if (-not $TunnelName) { $TunnelName = 'idle-rpg' }
  if ($Hostname -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') { throw "Invalid -Hostname: $Hostname (expected a bare name such as game.example.com)" }
  if ($TunnelName -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid -TunnelName: $TunnelName" }
  $setupHint = "Run the one-time setup first (docs/ops/self-host-tunnel.md): cloudflared tunnel login; cloudflared tunnel create $TunnelName; cloudflared tunnel route dns $TunnelName $Hostname"
  $tunnelJson = ''
  try { $tunnelJson = (& cloudflared tunnel list --output json 2>$null) -join "`n" } catch { $tunnelJson = '' }
  $tunnelId = $null
  if ($tunnelJson) {
    $tunnels = @($tunnelJson | ConvertFrom-Json)
    foreach ($t in $tunnels) {
      if ($t.name -eq $TunnelName) { $tunnelId = [string]$t.id; break }
    }
  }
  if (-not $tunnelId) { throw "Cloudflare tunnel '$TunnelName' not found. $setupHint" }
  $credentialsFile = Join-Path (Join-Path $env:USERPROFILE '.cloudflared') "$tunnelId.json"
  if (-not (Test-Path $credentialsFile)) { throw "Credentials file $credentialsFile not found for tunnel '$TunnelName'. $setupHint" }
  # A dedicated config: the global ~/.cloudflared/config.yml is never read or modified.
  # Single-quoted YAML scalar so backslashes in the Windows path stay literal.
  $yamlCredentials = $credentialsFile.Replace("'", "''")
  $configLines = @(
    "tunnel: $TunnelName",
    "credentials-file: '$yamlCredentials'",
    'ingress:',
    "  - hostname: $Hostname",
    '    service: http://127.0.0.1:3000',
    '  - service: http_status:404'
  )
  [System.IO.File]::WriteAllLines($namedConfig, [string[]]$configLines, (New-Object System.Text.UTF8Encoding($false)))
} elseif ($TunnelName) {
  throw '-TunnelName only makes sense together with -Hostname'
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

if ($Hostname) {
  Write-Host "Starting the Cloudflare named tunnel '$TunnelName' for $Hostname..."
  $tunnel = Start-Process -FilePath 'cloudflared' -PassThru -WindowStyle Hidden `
    -ArgumentList @('tunnel', '--no-autoupdate', '--config', ('"' + $namedConfig + '"'), '--logfile', ('"' + $log + '"'), 'run', $TunnelName)
  Set-Content -Path $pidFile -Value $tunnel.Id
  Start-Sleep -Seconds 1
  if ($tunnel.HasExited) { throw "cloudflared exited early; see $log" }
  $url = "https://$Hostname"
} else {
  Write-Host 'Starting the Cloudflare quick tunnel...'
  $tunnel = Start-Process -FilePath 'cloudflared' -PassThru -WindowStyle Hidden `
    -ArgumentList @('tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3000', '--logfile', ('"' + $log + '"'))
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
}

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

if ($Hostname) {
  Write-Host 'Checking the public URL (DNS can lag behind a new route)...'
  $publicOk = $false
  $deadline = (Get-Date).AddSeconds(60)
  while (-not $publicOk -and (Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri "$url/health/ready" -UseBasicParsing -TimeoutSec 3
      $publicOk = $response.StatusCode -eq 200
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $publicOk) { Write-Warning "$url/health/ready did not answer within 60 s. DNS or the tunnel may still be settling; check $log" }
}

Write-Host ''
Write-Host "Ready. Open on the phone: $url" -ForegroundColor Green
if ($Staging) { Write-Host 'Staging mode: the debug panel is enabled. Keep the URL private.' -ForegroundColor Yellow }
if ($Hostname) {
  Write-Host 'Stable URL: it does not change on restart, so saved progress (guest account) persists.'
} else {
  Write-Host 'The URL changes every time the tunnel restarts (a new URL means a new guest account on the phone).'
}
Write-Host 'Stop everything with: powershell -ExecutionPolicy Bypass -File scripts\selfhost\down.ps1'
