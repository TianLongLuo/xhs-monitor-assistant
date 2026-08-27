param(
  [Alias('SeedXlsx')]
  [string]$SeedCsv = '',
  [int]$Port = 17881
)

$bridgeScript = Join-Path $PSScriptRoot 'server.py'
if ($SeedCsv) {
  python $bridgeScript --host 127.0.0.1 --port $Port --seed-csv $SeedCsv
} else {
  # 未指定时由 server.py 读取 native_host_config.json，或创建项目 data 目录默认 CSV。
  python $bridgeScript --host 127.0.0.1 --port $Port
}
