param(
  [string]$SeedXlsx = '',
  [int]$Port = 17881
)

$bridgeScript = Join-Path $PSScriptRoot 'server.py'
if ($SeedXlsx) {
  python $bridgeScript --host 127.0.0.1 --port $Port --seed-xlsx $SeedXlsx
} else {
  # 未指定时由 server.py 读取 native_host_config.json，或使用项目 data 目录默认总表
  python $bridgeScript --host 127.0.0.1 --port $Port
}
