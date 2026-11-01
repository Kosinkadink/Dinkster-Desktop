param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][ValidateSet('control', 'offline-observed')][string]$Mode
)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $Executable)) { throw 'Installed executable missing' }
if ($Mode -eq 'control' -and (Test-Path -LiteralPath $VerificationRoot)) { throw 'Control needs a new root' }
if ($Mode -eq 'offline-observed' -and !(Test-Path -LiteralPath (Join-Path $VerificationRoot 'online.json'))) { throw 'Online receipt missing' }
$script = Join-Path $PSScriptRoot $(if ($Mode -eq 'control') { 'verify-tools-download.mjs' } else { 'verify-bundled-tools.mjs' })
$logRoot = Split-Path -Parent $VerificationRoot
$stdout = Join-Path $logRoot "$Mode-stdout.log"
$stderr = Join-Path $logRoot "$Mode-stderr.log"
if ((Test-Path $stdout) -or (Test-Path $stderr)) { throw 'Refusing to replace observer logs' }
$oldExecutable = $env:DINKSTER_DESKTOP_EXECUTABLE
$oldRoot = $env:DINKSTER_BUNDLED_VERIFY_ROOT
$samples = [System.Collections.Generic.List[object]]::new()
$known = [System.Collections.Generic.HashSet[int]]::new()
$clock = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $env:DINKSTER_DESKTOP_EXECUTABLE = $Executable
    $env:DINKSTER_BUNDLED_VERIFY_ROOT = $VerificationRoot
    $arguments = @("`"$script`"")
    if ($Mode -ne 'control') { $arguments += $Mode }
    $process = Start-Process -FilePath (Get-Command node).Source -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    [void]$known.Add($process.Id)
    do {
        $started = $clock.ElapsedMilliseconds
        $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | Select-Object ProcessId,ParentProcessId)
        do {
            $added = $false
            foreach ($row in $rows) {
                if ($known.Contains([int]$row.ParentProcessId) -and $known.Add([int]$row.ProcessId)) { $added = $true }
            }
        } while ($added)
        $tcp = @(Get-NetTCPConnection | Where-Object { $known.Contains([int]$_.OwningProcess) } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess)
        $udp = @(Get-NetUDPEndpoint | Where-Object { $known.Contains([int]$_.OwningProcess) } | Select-Object LocalAddress,LocalPort,OwningProcess)
        $samples.Add([pscustomobject]@{ elapsedMs = $started; queryMs = $clock.ElapsedMilliseconds - $started; tcp = $tcp; udp = $udp })
        $delay = 200 - ($clock.ElapsedMilliseconds - $started)
        if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
        $process.Refresh()
    } while (!$process.HasExited)
    $process.WaitForExit()
    $externalTcp = @($samples | ForEach-Object { $_.tcp } | Where-Object { $_.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0$|::$)' })
    # UDP endpoint APIs do not expose destinations. Treat any non-loopback
    # binding conservatively as an observation that needs investigation.
    $nonLoopbackUdp = @($samples | ForEach-Object { $_.udp } | Where-Object { $_.LocalAddress -notmatch '^(127\.|::1$)' })
    $receipt = [pscustomobject]@{
        mode = $Mode; observationBased = $true; targetIntervalMs = 200
        rootPid = $process.Id; processIds = @($known); exitCode = $process.ExitCode
        externalTcp = $externalTcp; nonLoopbackUdp = $nonLoopbackUdp; samples = @($samples.ToArray())
    }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $logRoot "$Mode-endpoints.json")
    if ($process.ExitCode -ne 0) { throw "Acceptance process failed: $($process.ExitCode); inspect retained logs" }
    if ($Mode -eq 'control') {
        if ($externalTcp.Count -eq 0) { throw 'Probe missed the actual tools-download control' }
    } elseif ($externalTcp.Count -ne 0 -or $nonLoopbackUdp.Count -ne 0) {
        throw 'Observed non-loopback endpoints; do not claim no outbound activity'
    }
    Write-Output "Observation completed: $Mode; samples=$($samples.Count); external TCP=$($externalTcp.Count); non-loopback UDP bindings=$($nonLoopbackUdp.Count)"
} finally {
    $env:DINKSTER_DESKTOP_EXECUTABLE = $oldExecutable
    $env:DINKSTER_BUNDLED_VERIFY_ROOT = $oldRoot
}
