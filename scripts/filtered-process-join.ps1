function Start-FilteredProcess {
  param([Diagnostics.ProcessStartInfo] $Start, [string] $ForwardPath, [string[]] $Prefixes)
  $process = [Diagnostics.Process]::Start($Start)
  $process.StandardInput.Close()
  Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action {
    $line = $Event.SourceEventArgs.Data
    if ($null -eq $line) { return }
    foreach ($prefix in $Event.MessageData.prefixes) {
      if ($line.StartsWith($prefix, [StringComparison]::Ordinal)) {
        Add-Content -LiteralPath $Event.MessageData.path -Value $line -Encoding ascii
        return
      }
    }
  } -MessageData @{ prefixes = $Prefixes; path = $ForwardPath } | Out-Null
  Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action {} | Out-Null
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  return $process
}

function Wait-FilteredProcess {
  param([Diagnostics.Process] $Process, [int] $TimeoutMilliseconds)
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not $Process.HasExited -and $clock.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    Wait-Event -Timeout 0.05 | Out-Null
  }
  if (-not $Process.HasExited) { return @{ completed = $false; classification = 'join-timeout' } }
  return @{ completed = $true; exitCode = $Process.ExitCode }
}
