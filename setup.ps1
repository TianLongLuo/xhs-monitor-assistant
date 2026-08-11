# One-click setup for the Chrome extension and its Native Messaging bridge.
# This file is intentionally ASCII-only for Windows PowerShell 5.1 compatibility.
param(
  [string]$ExtensionId = '',
  [string]$SeedXlsx = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionDir = [System.IO.Path]::GetFullPath((Join-Path $root 'extension')).TrimEnd('\')
$bridgeDir = Join-Path $root 'bridge'
$hostExe = Join-Path $bridgeDir 'dist\xhs_monitor_native_host.exe'

function Find-LocalExtensionId {
  $userData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  if (-not (Test-Path -LiteralPath $userData)) { return @() }
  $ids = New-Object System.Collections.Generic.List[string]
  Get-ChildItem -LiteralPath $userData -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' } |
    ForEach-Object {
      $prefs = Join-Path $_.FullName 'Secure Preferences'
      if (-not (Test-Path -LiteralPath $prefs)) { return }
      try {
        $json = Get-Content -LiteralPath $prefs -Raw -Encoding UTF8 | ConvertFrom-Json
        $settings = $json.extensions.settings
        if (-not $settings) { return }
        foreach ($property in $settings.PSObject.Properties) {
          $candidate = [string]$property.Value.path
          if (-not $candidate) { continue }
          try { $candidate = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\') } catch { continue }
          if ($candidate -ieq $extensionDir -and $property.Name -match '^[a-p]{32}$') {
            if (-not $ids.Contains($property.Name)) { $ids.Add($property.Name) }
          }
        }
      } catch {}
    }
  return $ids.ToArray()
}

Write-Host 'XHS Monitor setup wizard' -ForegroundColor Cyan
Write-Host "Project: $root"

if (-not $ExtensionId) {
  $detected = @(Find-LocalExtensionId)
  if ($detected.Count -eq 1) {
    $ExtensionId = $detected[0]
    Write-Host "Detected extension ID: $ExtensionId" -ForegroundColor Green
  } elseif ($detected.Count -gt 1) {
    Write-Host 'Detected extension IDs:'
    $detected | ForEach-Object { Write-Host "  $_" }
  }
}

if (-not $ExtensionId) {
  Write-Host 'Open chrome://extensions, load the extension folder, then copy its 32-letter ID.' -ForegroundColor Yellow
  Write-Host "Extension folder: $extensionDir"
  $ExtensionId = Read-Host 'Extension ID'
}
$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Invalid Chrome extension ID.' }

if (-not (Test-Path -LiteralPath (Join-Path $bridgeDir 'data\relevance_keywords.json'))) {
  $example = Join-Path $bridgeDir 'relevance_keywords.example.json'
  if (Test-Path -LiteralPath $example) {
    New-Item -ItemType Directory -Path (Join-Path $bridgeDir 'data') -Force | Out-Null
    Copy-Item -LiteralPath $example -Destination (Join-Path $bridgeDir 'data\relevance_keywords.json')
  }
}

if (-not $SkipBuild -or -not (Test-Path -LiteralPath $hostExe)) {
  & (Join-Path $bridgeDir 'build_native_host.ps1')
  if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
}

$installArgs = @{ ExtensionId = $ExtensionId }
if ($SeedXlsx) { $installArgs.SeedXlsx = $SeedXlsx }
& (Join-Path $bridgeDir 'install_native_host.ps1') @installArgs

Start-Process -FilePath $hostExe -ArgumentList '--bridge' -WindowStyle Hidden
$health = $null
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17881/api/health' -TimeoutSec 2
    if ($health.ok) { break }
  } catch {}
}
if (-not $health.ok) { throw 'Registration succeeded, but the local bridge health check failed.' }

Write-Host ''
Write-Host 'Setup completed.' -ForegroundColor Green
Write-Host "Extension ID: $ExtensionId"
Write-Host "Bridge version: $($health.version)"
Write-Host 'Reload the extension at chrome://extensions and refresh the XHS page.'
