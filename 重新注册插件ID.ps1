# 用法：在 chrome://extensions 里从新目录重新加载扩展后，把新的插件 ID 填进来运行
# 例如：.\重新注册插件ID.ps1 -ExtensionId abcdefghijklmnopqrstuvwxyz123456
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'bridge\install_native_host.ps1') -ExtensionId $ExtensionId -SkipSeed
Write-Output "完成：Native Host 已绑定新插件 ID $ExtensionId"
