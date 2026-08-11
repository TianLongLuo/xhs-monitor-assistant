$hostName = 'com.xhsmonitor.bridge'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
if (Test-Path -LiteralPath $registryPath) {
  Remove-Item -LiteralPath $registryPath -Recurse -Force
  Write-Output "Native Host registry entry removed."
} else {
  Write-Output "Native Host registry entry was not found."
}
