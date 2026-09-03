[CmdletBinding()]
param(
  [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $InstallerPath = Join-Path $PSScriptRoot '..\artifacts\ETTA-Time-Tracker-Setup-0.1.0-x64.exe'
}

$sandboxExecutable = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not (Test-Path -LiteralPath $sandboxExecutable)) {
  throw 'Windows Sandbox is not installed. Enable Containers-DisposableClientVM, reboot, and run this again.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$absoluteInstaller = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallerPath)
if (-not (Test-Path -LiteralPath $absoluteInstaller)) {
  throw 'Installer not found.'
}

$repoRootPrefix = $repoRoot + '\'
if (-not $absoluteInstaller.StartsWith($repoRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The installer must be inside the repository.'
}

$resultHostFolder = Join-Path $repoRoot 'artifacts\sandbox-results'
New-Item -ItemType Directory -Path $resultHostFolder -Force | Out-Null
$relativeInstaller = $absoluteInstaller.Substring($repoRootPrefix.Length).Replace('\', '/')
$installerSandboxPath = 'C:\ETTA\' + $relativeInstaller
$quote = [char]34
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $quote + 'C:\ETTA\scripts\test-windows-installer.ps1' + $quote + ' -InstallerPath ' + $quote + $installerSandboxPath + $quote + ' -ResultPath ' + $quote + 'C:\ETTA-Results\result.log' + $quote

$escapedRepoRoot = [System.Security.SecurityElement]::Escape($repoRoot)
$escapedResultFolder = [System.Security.SecurityElement]::Escape($resultHostFolder)
$escapedCommand = [System.Security.SecurityElement]::Escape($command)
$sandboxConfig = @'
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>{0}</HostFolder>
      <SandboxFolder>C:\ETTA</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>{1}</HostFolder>
      <SandboxFolder>C:\ETTA-Results</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>{2}</Command>
  </LogonCommand>
</Configuration>
'@ -f $escapedRepoRoot, $escapedResultFolder, $escapedCommand

$sandboxConfigPath = Join-Path $resultHostFolder 'ETTA-Windows-Sandbox-Test.wsb'
Set-Content -LiteralPath $sandboxConfigPath -Value $sandboxConfig -Encoding UTF8
$sandboxArgument = $quote + $sandboxConfigPath + $quote
Start-Process -FilePath $sandboxExecutable -ArgumentList $sandboxArgument
Write-Host 'Windows Sandbox test started.'
Write-Host ('Results: ' + (Join-Path $resultHostFolder 'result.log'))
