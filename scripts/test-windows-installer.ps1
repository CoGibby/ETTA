[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$ResultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-TestLog {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format o), $Message
  Write-Host $line
  if ($ResultPath) { Add-Content -LiteralPath $ResultPath -Value $line }
}

function Wait-TestFile {
  param([string]$Path, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Path) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-PackagedServerPort {
  param([int]$TimeoutSeconds = 90)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $processes = Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*next*server.js*' }
    foreach ($process in $processes) {
      $listeners = Get-NetTCPConnection -OwningProcess ([int]$process.ProcessId) -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' }
      if ($listeners) { return [int]($listeners | Select-Object -First 1).LocalPort }
    }
    Start-Sleep -Seconds 1
  }
  return 0
}

function Stop-TestApp {
  param([System.Diagnostics.Process]$Process)
  if ($Process -and -not $Process.HasExited) {
    $Process.CloseMainWindow() | Out-Null
    Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force
      Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
    }
  }
}

if (-not (Test-Path -LiteralPath $InstallerPath)) { throw 'Installer not found.' }
if (Test-Path Env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE }

$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\ETTA Time Tracker'
$appPath = Join-Path $installRoot 'ETTA Time Tracker.exe'
$uninstallerPath = Join-Path $installRoot 'Uninstall ETTA Time Tracker.exe'
$dataRoot = Join-Path $env:APPDATA 'etta-time-tracker'
$databasePath = Join-Path $dataRoot 'data\timekeeper.db'
$serverLogPath = Join-Path $dataRoot 'logs\server.log'
$appProcess = $null
$exitCode = 0

if ($ResultPath) {
  $resultDirectory = Split-Path -Parent $ResultPath
  if ($resultDirectory -and -not (Test-Path -LiteralPath $resultDirectory)) {
    New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
  }
  Set-Content -LiteralPath $ResultPath -Value 'ETTA Windows installer test'
}

try {
  if (Test-Path -LiteralPath $appPath) { throw 'A previous installation exists. Use Windows Sandbox or a clean profile.' }
  if (Test-Path -LiteralPath $dataRoot) { throw 'Previous application data exists. Use Windows Sandbox or a clean profile.' }

  $hash = Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256
  Write-TestLog 'Installing the internal build'
  Write-TestLog ('SHA256 ' + $hash.Hash)
  $installerProcess = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru -Wait
  if ($installerProcess.ExitCode -ne 0) { throw 'Installer failed.' }
  if (-not (Wait-TestFile -Path $appPath -TimeoutSeconds 60)) { throw 'Installed executable missing.' }
  Write-TestLog 'Installer completed'

  $appProcess = Start-Process -FilePath $appPath -PassThru
  Start-Sleep -Seconds 3
  $appProcess.Refresh()
  if ($appProcess.HasExited) { throw 'The packaged application exited during startup.' }

  $port = Get-PackagedServerPort
  if ($port -eq 0) { throw 'The packaged server did not listen on 127.0.0.1.' }
  Write-TestLog ('Packaged server listening on port ' + $port)

  $settings = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/api/settings') -UseBasicParsing -TimeoutSec 20
  $outlook = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/api/outlook/status') -UseBasicParsing -TimeoutSec 20
  if ($settings.StatusCode -ne 200 -or $outlook.StatusCode -ne 200) { throw 'Health endpoint failure.' }
  Write-TestLog 'Health endpoints returned HTTP 200'

  if (-not (Wait-TestFile -Path $databasePath)) { throw 'Database missing.' }
  if (-not (Wait-TestFile -Path $serverLogPath)) { throw 'Server log missing.' }
  Write-TestLog 'Verified per-user files'

  Stop-TestApp -Process $appProcess
  $appProcess = $null
  Write-TestLog 'Stopped packaged application'

  if (-not (Test-Path -LiteralPath $uninstallerPath)) { throw 'Uninstaller missing.' }
  $uninstallerProcess = Start-Process -FilePath $uninstallerPath -ArgumentList '/S' -PassThru -Wait
  if ($uninstallerProcess.ExitCode -ne 0) { throw 'Uninstaller failed.' }
  if (Wait-TestFile -Path $appPath -TimeoutSeconds 1) { throw 'Uninstaller did not remove the executable.' }
  if (-not (Test-Path -LiteralPath $databasePath) -or -not (Test-Path -LiteralPath $serverLogPath)) { throw 'Uninstall removed runtime data.' }
  Write-TestLog 'Uninstall completed and retained runtime data'
  Write-TestLog 'PASS'
} catch {
  Write-TestLog ('FAIL: ' + $_.Exception.Message)
  $exitCode = 1
} finally {
  Stop-TestApp -Process $appProcess
}

exit $exitCode
