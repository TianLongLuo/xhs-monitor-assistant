# Builds the Native Host exe with PyInstaller.
# Note: keep this file ASCII-only so Windows PowerShell 5.1 parses it regardless of BOM.
param(
  [switch]$Quiet
)

$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDir = Join-Path $bridgeDir 'dist'
$buildDir = Join-Path $bridgeDir 'build'

$ErrorActionPreference = 'Continue'
python -m PyInstaller --clean --noconfirm --onefile --name xhs_monitor_native_host `
  --distpath $distDir `
  --workpath $buildDir `
  --specpath $buildDir `
  --hidden-import openpyxl `
  (Join-Path $bridgeDir 'native_host.py')
if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller build failed with exit code $LASTEXITCODE"
}

Write-Output "Native Host built: $(Join-Path $distDir 'xhs_monitor_native_host.exe')"
