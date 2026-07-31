# Kill all processes related to tauri:dev (brightcode.exe + node under BrightCode path).
$ErrorActionPreference = 'SilentlyContinue'

Get-Process brightcode -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output "killing brightcode PID $($_.Id)"
  Stop-Process -Id $_.Id -Force
}

Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and (
    $_.CommandLine -like '*BrightCode*' -or
    $_.CommandLine -like '*vite*' -or
    $_.CommandLine -like '*node-sidecar*'
  )
} | ForEach-Object {
  Write-Output "killing node PID $($_.ProcessId): $($_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length)))"
  Stop-Process -Id $_.ProcessId -Force
}