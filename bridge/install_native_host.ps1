param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string[]]$ExtensionId,
  [string]$SeedXlsx = '',
  [int]$Port = 17881,
  [switch]$SkipSeed
)

$ErrorActionPreference = 'Stop'
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostName = 'com.xhsmonitor.bridge'
$hostExe = Join-Path $bridgeDir 'dist\xhs_monitor_native_host.exe'
$hostManifest = Join-Path $bridgeDir "$hostName.json"
$hostConfig = Join-Path $bridgeDir 'native_host_config.json'
$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

if (-not (Test-Path -LiteralPath $hostExe)) {
  throw "找不到 Native Host：$hostExe。请先运行 bridge/build_native_host.ps1。"
}

$dataDir = Join-Path $bridgeDir 'data'
$exportDir = Join-Path $bridgeDir 'exports'
New-Item -ItemType Directory -Path $dataDir,$exportDir -Force | Out-Null

# 总表路径优先级：参数 > 已有配置 > 项目 data 目录默认值（首次拉取时自动创建）
if (-not $SeedXlsx -and (Test-Path -LiteralPath $hostConfig)) {
  try {
    $existing = Get-Content -LiteralPath $hostConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existing.seed_xlsx) { $SeedXlsx = [string]$existing.seed_xlsx }
  } catch {}
}
if (-not $SeedXlsx) {
  $SeedXlsx = Join-Path (Split-Path -Parent $bridgeDir) 'data\小红书笔记评论总表.xlsx'
}

$config = [ordered]@{
  host = '127.0.0.1'
  port = $Port
  db = (Join-Path $dataDir 'xhs_monitor.db')
  export_dir = $exportDir
  seed_xlsx = $SeedXlsx
}
Write-Utf8NoBom -Path $hostConfig -Content ($config | ConvertTo-Json)

if (-not $SkipSeed) {
  if (Test-Path -LiteralPath $SeedXlsx) {
    python (Join-Path $bridgeDir 'server.py') --seed-only --db (Join-Path $dataDir 'xhs_monitor.db') --export-dir $exportDir --seed-xlsx $SeedXlsx
  } else {
    Write-Output "总表尚不存在：$SeedXlsx（首次拉取时 Bridge 会自动创建，跳过初始化）"
  }
}

$manifest = [ordered]@{
  name = $hostName
  description = 'Starts the XHS-Monitor local monitoring bridge on demand.'
  path = $hostExe
  type = 'stdio'
  allowed_origins = @($ExtensionId | Select-Object -Unique | ForEach-Object { "chrome-extension://$_/" })
}
Write-Utf8NoBom -Path $hostManifest -Content ($manifest | ConvertTo-Json)

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name '(default)' -Value $hostManifest

Write-Output "Native Host 已注册。"
Write-Output "插件 ID：$($ExtensionId -join ', ')"
Write-Output "Host：$hostExe"
Write-Output "点击插件图标打开侧边栏时，Bridge 才会启动。"
