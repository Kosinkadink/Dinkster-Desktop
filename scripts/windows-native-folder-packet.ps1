[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $VerifyRoot,
  [Parameter(Mandatory)] [string] $BackendSource,
  [Parameter(Mandatory)] [string] $FrontendDist,
  [Parameter(Mandatory)] [string] $ElectronExecutable,
  [switch] $PreflightOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopHead = 'd838fe6d8272b56efc547d7a313d2b4e8a544023'
$backendHead = '70ee7cba18d2de361daad583f6857d79efd3600b'
$frontendHead = 'c34ac40785b1aa7f8b55506d4aa69063b62cb5ce'
$electronHash = '8d205e25b40da3ada4a08c92f32bfbd8e8d38edb4bfe443deea77fc9de685bac'
$frontendHash = '107f882cf4e35cb8acdcbcb666862ac5b2338c2a86f77a128c4985a2aef64416'
$mainHash = '216fe2df504975551922fc0bbf7a135e2b41b3ec5ddf2d2b62927749f448e6bf'
$preloadHash = 'a49830ed4db1f76d45fff7a1aeb43e594854fea31eb4dae500821ac6aea88c8b'
$helperHash = 'dfdcd84ab1f0ce5b12c775c8429dddfb71e145004bd00874f3a7828179b7bce1'
$driverHash = '752e6c08a9b23223ad01e536ecdd7d207db8d2cb1b549a75b9287486d45b95b5'
$nativeHash = '9fdde5108387d2d8adfd6c6060723fbc57dd8658ee7438f43978fe6a6873ab55'
$harnessHash = '0265e4161f22b976235cfccd1fa87a4dfb3539b70dc2e469e257379af9ce4692'
$packetDirectory = Split-Path -Parent $PSCommandPath
. (Join-Path $packetDirectory 'filtered-process-join.ps1')
$desktopRoot = Resolve-Path (Join-Path $packetDirectory '..\..\..')
$harness = Join-Path $packetDirectory 'windows-native-folder-cells.mjs'
$driver = Join-Path $packetDirectory 'windows-native-folder-driver.ps1'
$statusPath = Join-Path (Split-Path $packetDirectory -Parent) 'native-packet-status-owned-input.jsonl'
$stdoutPath = Join-Path $VerifyRoot 'harness.stdout.log'
$stderrPath = Join-Path $VerifyRoot 'harness.stderr.log'
$readyPath = Join-Path $VerifyRoot 'isolated-native-folder-ready.json'
$catalogPath = Join-Path $VerifyRoot 'phase-catalog-validated.json'
$backendReadyPath = Join-Path $VerifyRoot 'phase-backend-ready.json'

function Add-Status {
  param([string] $State, [hashtable] $Fields = @{})
  $record = [ordered]@{ timestamp = (Get-Date).ToString('o'); state = $State }
  foreach ($key in $Fields.Keys) { $record[$key] = $Fields[$key] }
  ($record | ConvertTo-Json -Compress) | Add-Content -LiteralPath $statusPath -Encoding ascii
}

function Require-Equal {
  param([string] $Actual, [string] $Expected, [string] $Failure)
  if (-not [string]::Equals($Actual.Trim(), $Expected, [StringComparison]::OrdinalIgnoreCase)) { throw $Failure }
}

function Require-CleanDetached {
  param([string] $Repository, [string] $Expected, [string] $Failure)
  $head = git -C $Repository rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw "$Failure HEAD query failed" }
  Require-Equal $head $Expected $Failure
  $status = @(git -C $Repository status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw "$Failure status query failed" }
  if ($status.Count -ne 0) { throw "$Failure working tree is not clean" }
  $branch = git -C $Repository symbolic-ref -q HEAD 2>$null
  if ($LASTEXITCODE -eq 0 -and $branch) { throw "$Failure is not detached" }
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { throw "$Failure detached query failed" }
}

function Wait-File {
  param([string] $Path, [int] $Seconds, [Diagnostics.Process] $HarnessProcess)
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  while ($deadline.Elapsed.TotalSeconds -lt $Seconds) {
    if (Test-Path -LiteralPath $Path) { return }
    if ($HarnessProcess.HasExited) { throw 'Harness exited before its required ready record' }
    Start-Sleep -Milliseconds 100
  }
  throw 'Harness startup deadline exceeded'
}

function Set-RestrictedEnvironment {
  param([Diagnostics.ProcessStartInfo] $Start)
  $Start.Environment.Clear()
  foreach ($name in @('SystemRoot', 'ComSpec', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $Start.Environment[$name] = $value }
  }
}

$harnessProcess = $null
$driverProcess = $null
$knownMainPid = $null
try {
  Require-CleanDetached $desktopRoot $desktopHead 'Diagnostic desktop mismatch'
  Require-CleanDetached $BackendSource $backendHead 'Frozen backend mismatch'
  $frontendRoot = Split-Path (Split-Path $FrontendDist -Parent) -Parent
  Require-CleanDetached $frontendRoot $frontendHead 'Frozen frontend mismatch'
  Require-Equal ((Get-FileHash $ElectronExecutable -Algorithm SHA256).Hash) $electronHash 'Retained Electron hash mismatch'
  Require-Equal ((Get-FileHash (Join-Path $FrontendDist 'index.html') -Algorithm SHA256).Hash) $frontendHash 'Frontend dist hash mismatch'
  Require-Equal ((Get-FileHash (Join-Path $desktopRoot 'packages\desktop\dist\main.js') -Algorithm SHA256).Hash) $mainHash 'Diagnostic main hash mismatch'
  Require-Equal ((Get-FileHash (Join-Path $desktopRoot 'packages\desktop\dist\preload.cjs') -Algorithm SHA256).Hash) $preloadHash 'Diagnostic preload hash mismatch'
  Require-Equal ((Get-FileHash (Join-Path $packetDirectory 'filtered-process-join.ps1') -Algorithm SHA256).Hash) $helperHash 'Shared helper hash mismatch'
  Require-Equal ((Get-FileHash $driver -Algorithm SHA256).Hash) $driverHash 'Driver hash mismatch'
  Require-Equal ((Get-FileHash (Join-Path $packetDirectory 'windows-owned-picker.cs') -Algorithm SHA256).Hash) $nativeHash 'Native helper hash mismatch'
  Require-Equal ((Get-FileHash $harness -Algorithm SHA256).Hash) $harnessHash 'Harness hash mismatch'
  if ((hostname).Trim() -ne 'TESTPC' -or [Environment]::UserName -ne 'kosin') { throw 'Host identity mismatch' }
  if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 1) { throw 'Invoking process session mismatch' }
  if (-not (quser | Select-String 'kosin.*console\s+1\s+Active' -Quiet)) { throw 'Console session mismatch' }
  if ($PreflightOnly) { Write-Output 'preflight-passed'; return }
  if (Test-Path -LiteralPath $VerifyRoot) { throw 'Verify root must be absent' }
  Add-Status 'preflight-passed' @{}

  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'node.exe'
  $start.Arguments = ('"{0}"' -f $harness)
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.RedirectStandardInput = $true
  Set-RestrictedEnvironment $start
  $start.Environment['DINKSTER_DESKTOP_VERIFY_ROOT'] = $VerifyRoot
  $start.Environment['DINKSTER_DIAGNOSTIC_DESKTOP_ENTRY'] = (Join-Path $desktopRoot 'packages\desktop')
  $start.Environment['DINKSTER_ENGINE_SOURCE'] = $BackendSource
  $start.Environment['DINKSTER_REF'] = $backendHead
  $start.Environment['DINKSTER_DIAGNOSTIC_ELECTRON_EXECUTABLE'] = $ElectronExecutable
  $start.Environment['DINKSTER_DESKTOP_VERIFY_NETWORK_DIRECTORY'] = '\\IntelPC\dinkster-scratch'
  $start.Environment['DINKSTER_DESKTOP_VERIFY_MAPPED_DIRECTORY'] = 'Z:\'
  $safePrompts = @(
    'Select this folder in the native dialog:',
    'Cancel the next native folder dialog'
  )
  $harnessProcess = Start-FilteredProcess $start $stdoutPath $safePrompts
  Add-Status 'harness-started' @{ launcherPid = $harnessProcess.Id }
  Wait-File $catalogPath 60 $harnessProcess
  Add-Status 'catalog-validated' @{}
  Wait-File $readyPath 60 $harnessProcess
  $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
  $knownMainPid = [int] $ready.mainPid
  Add-Status 'owned-main-identified' @{ mainPid = [int] $ready.mainPid; launcherPid = $harnessProcess.Id }
  Wait-File $backendReadyPath 600 $harnessProcess
  Add-Status 'backend-ready' @{}
  $driverStart = [Diagnostics.ProcessStartInfo]::new()
  $driverStart.FileName = 'pwsh.exe'
  $driverStart.Arguments = ('-NoProfile -File "{0}" -RunnerPid {1} -HarnessStdoutPath "{2}" -EvidencePath "{3}" -LocalPath "{4}" -UncPath "{5}" -MappedDrive Z: -MapReadyPath "{6}" -MappedResultPath "{7}" -TimeoutSeconds 60' -f $driver, $ready.mainPid, $stdoutPath, (Join-Path $VerifyRoot 'native-actions.jsonl'), (Join-Path $VerifyRoot 'local folder with spaces'), '\\IntelPC\dinkster-scratch', (Join-Path $VerifyRoot 'mapped-drive-ready'), (Join-Path $VerifyRoot 'mapped-folder-result-acknowledged'))
  $driverStart.UseShellExecute = $false
  $driverStart.RedirectStandardInput = $true
  $driverStart.RedirectStandardOutput = $true
  $driverStart.RedirectStandardError = $true
  Set-RestrictedEnvironment $driverStart
  $driverProcess = [Diagnostics.Process]::Start($driverStart)
  $driverProcess.StandardInput.Close()
  Register-ObjectEvent -InputObject $driverProcess -EventName OutputDataReceived -Action {} | Out-Null
  Register-ObjectEvent -InputObject $driverProcess -EventName ErrorDataReceived -Action {} | Out-Null
  $driverProcess.BeginOutputReadLine()
  $driverProcess.BeginErrorReadLine()
  Add-Status 'driver-started' @{ driverPid = $driverProcess.Id; mainPid = [int] $ready.mainPid }
  $driverJoin = Wait-FilteredProcess $driverProcess 300000
  if (-not $driverJoin.completed) {
    Add-Status 'safe-failure' @{ classification = 'driver-join-timeout' }
    throw 'Driver join deadline exceeded'
  }
  if ($driverProcess.ExitCode -ne 0) {
    Add-Status 'safe-failure' @{ classification = 'driver-failed' }
    throw 'Driver failed'
  }
  $harnessJoin = Wait-FilteredProcess $harnessProcess 700000
  if (-not $harnessJoin.completed) {
    Add-Status 'safe-failure' @{ classification = 'harness-join-timeout' }
    throw 'Harness join deadline exceeded'
  }
  if ($harnessProcess.ExitCode -ne 0) {
    Add-Status 'safe-failure' @{ classification = 'harness-failed' }
    throw 'Harness failed'
  }
  Add-Status 'packet-completed' @{ launcherPid = $harnessProcess.Id; mainPid = [int] $ready.mainPid }
} catch {
  Add-Status 'safe-failure' @{ classification = 'preparation-orchestration-failure' }
  throw
} finally {
  if ($null -ne $harnessProcess -and -not $harnessProcess.HasExited) {
    Add-Status 'owned-process-lingering' @{ launcherPid = $harnessProcess.Id }
  }
  if ($null -ne $driverProcess -and -not $driverProcess.HasExited) {
    Add-Status 'owned-process-lingering' @{ driverPid = $driverProcess.Id }
  }
  if ($null -ne $knownMainPid) {
    $main = Get-Process -Id $knownMainPid -ErrorAction SilentlyContinue
    Add-Status 'owned-main-inventory' @{ mainPid = $knownMainPid; present = ($null -ne $main) }
  }
}
