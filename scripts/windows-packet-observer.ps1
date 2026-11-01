[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Root,
  [Parameter(Mandatory)] [ValidateSet('Benign', 'Preflight', 'Packet')] [string] $Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$spawned = $false
$childPid = $null
$childExitCode = $null
try {
  $diagnostics = Join-Path $Root 'desktop/.amp/in/diagnostics'
  $artifacts = Join-Path $Root 'desktop/.amp/in/artifacts'
  $stdout = Join-Path $artifacts ("observer-{0}.stdout.log" -f $Mode.ToLowerInvariant())
  $stderr = Join-Path $artifacts ("observer-{0}.stderr.log" -f $Mode.ToLowerInvariant())
  $journal = Join-Path $artifacts ("observer-{0}.json" -f $Mode.ToLowerInvariant())
  foreach ($path in @($stdout, $stderr, $journal)) {
    if (Test-Path -LiteralPath $path) { throw 'Observer destination already exists' }
  }
  if (-not (Test-Path -LiteralPath $artifacts -PathType Container)) { throw 'Artifact directory missing' }
  $arguments = @('-NoProfile', '-File')
  if ($Mode -eq 'Benign') {
    $arguments += Join-Path $diagnostics 'windows-owned-picker.test.ps1'
  } else {
    $arguments += @(
      (Join-Path $diagnostics 'windows-native-folder-packet.ps1'),
      '-VerifyRoot', (Join-Path $Root 'n'),
      '-BackendSource', (Join-Path $Root 'backend'),
      '-FrontendDist', (Join-Path $Root 'frontend/packages/app/dist'),
      '-ElectronExecutable', (Join-Path $Root 'electron-runtime-37.10.3/electron.exe')
    )
    if ($Mode -eq 'Preflight') { $arguments += '-PreflightOnly' }
  }
  $quoted = foreach ($argument in $arguments) {
    if ($argument -match '["\r\n]') { throw 'Unsupported child argument' }
    '"' + $argument + '"'
  }
  # Start-Process drains both redirected streams without PowerShell event callbacks.
  $child = Start-Process -FilePath 'pwsh.exe' -ArgumentList ($quoted -join ' ') -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $spawned = $true
  $childPid = $child.Id
  # Retain the handle and identity before waiting for this exact child, not its tree.
  $null = $child.Handle
  [ordered]@{ mode = $Mode; spawned = $true; childPid = $childPid; completed = $false } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $journal -Encoding ascii -NoNewline
  $child.WaitForExit()
  $childExitCode = $child.ExitCode
  if ($null -eq $childExitCode) { throw 'Child exit code unavailable' }
  $result = [ordered]@{
    mode = $Mode
    spawned = $spawned
    childPid = $childPid
    completed = $true
    childExitCode = $childExitCode
    observerSucceeded = $true
    benignPassed = $false
    preflightPassed = $false
  }
  if ($Mode -eq 'Benign' -and $childExitCode -eq 0) {
    $benign = Get-Content -LiteralPath $stdout -Raw | ConvertFrom-Json
    $result.benignPassed = (
      $benign.result -ceq 'owned-picker-benign-passed' -and
      $benign.originalCompiledOnly -ceq $true -and $benign.nativeCalls -ceq 0 -and
      $benign.identityRejections -ceq 5 -and $benign.ambiguousEditRejected -ceq $true -and
      $benign.unrelatedEditIgnored -ceq $true -and $benign.exactEditMismatchRejected -ceq $true -and
      $benign.committedMismatchDidNotSelect -ceq $true
    )
  }
  if ($Mode -eq 'Preflight' -and $childExitCode -eq 0) {
    $result.preflightPassed = (Get-Content -LiteralPath $stdout -Raw).Trim() -ceq 'preflight-passed'
  }
  $safe = $result | ConvertTo-Json -Compress
  Set-Content -LiteralPath $journal -Value $safe -Encoding ascii -NoNewline
  Write-Output $safe
  if ($childExitCode -ne 0) { exit 1 }
  if ($Mode -eq 'Benign' -and -not $result.benignPassed) { exit 1 }
  if ($Mode -eq 'Preflight' -and -not $result.preflightPassed) { exit 1 }
} catch {
  # Never expose child output or exception messages through the reporting channel.
  [ordered]@{
    mode = $Mode
    spawned = $spawned
    childPid = $childPid
    childExitCode = $childExitCode
    observerSucceeded = $false
    failureType = $_.Exception.GetType().FullName
  } | ConvertTo-Json -Compress | Write-Output
  exit 82
}
