param([Parameter(Mandatory)][ValidateSet('DownloadDesktop', 'Install', 'Cleanup')][string]$Action)

$ErrorActionPreference = 'Stop'
if ($Action -eq 'DownloadDesktop' -and -not $env:GH_TOKEN) {
    throw 'Missing Desktop release acquisition token; no fallback token is permitted'
}
if (-not $env:DINKSTER_VERIFY_WORK) { throw 'Set DINKSTER_VERIFY_WORK to a new isolated verification directory' }
$root = [IO.Path]::GetFullPath($env:DINKSTER_VERIFY_WORK)
$assets = Join-Path $root 'assets'
$proof = Join-Path $root 'proof'
$install = Join-Path $root 'app'
$data = Join-Path $root 'run'
$owner = Join-Path $root 'owned-install.json'
$desktop = Get-Content (Join-Path $PSScriptRoot 'published-desktop.json') -Raw | ConvertFrom-Json
if ($desktop.published -ne $true -and $Action -ne 'Cleanup') {
    throw 'No Dinkster Desktop release has been published'
}

function Assert-Artifact($Pin, [string]$Path) {
    if ((Get-Item -LiteralPath $Path).Length -ne $Pin.size -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() -cne $Pin.sha256) {
        throw "Published artifact checksum/size mismatch: $($Pin.archive)"
    }
}

function Get-ReleaseArtifact($Pin) {
    $repo = gh api "repos/$($Pin.repository)" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $repo.private) { throw 'Release repository must be private' }
    gh release download $Pin.releaseTag --repo $Pin.repository --pattern $Pin.archive --dir $assets
    if ($LASTEXITCODE -ne 0) { throw 'Pinned private release download failed' }
    Assert-Artifact $Pin (Join-Path $assets $Pin.archive)
}

if ($Action -eq 'DownloadDesktop') {
    if (Test-Path -LiteralPath $root) { throw 'Verification directory must be fresh' }
    New-Item -ItemType Directory -Path $assets, $proof | Out-Null
    Get-ReleaseArtifact $desktop
    return
}

# Installation and cleanup must not inherit acquisition credentials, even locally.
Get-ChildItem Env: | Where-Object { $_.Name -match 'TOKEN|SECRET|PASSWORD|CREDENTIAL|^GIT_' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" }
$protocol = 'Registry::HKEY_CURRENT_USER\Software\Classes\dinkster'
$executable = Join-Path $install 'Dinkster Desktop.exe'
if ($Action -eq 'Install') {
    Assert-Artifact $desktop (Join-Path $assets $desktop.archive)
    if ((Test-Path $install) -or (Test-Path $data) -or (Test-Path $owner) -or (Test-Path $protocol)) {
        throw 'Refusing to overwrite an existing installation, protocol, or verification environment'
    }
    $existing = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall -ErrorAction SilentlyContinue |
        Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Dinkster Desktop' }
    if ($existing) { throw 'Use a runner without an existing Dinkster Desktop installation' }
    @{ install = $install; data = $data } | ConvertTo-Json | Set-Content $owner
    $process = Start-Process -FilePath (Join-Path $assets $desktop.archive) -ArgumentList @('/S', '/currentuser', '/NODESKTOPSHORTCUT', "/D=$install") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }

    $descriptorPath = Join-Path $install 'resources/control-runtime/descriptor.json'
    $descriptor = Get-Content $descriptorPath -Raw | ConvertFrom-Json
    $expected = $desktop.controlRuntime
    if (-not $expected -or $descriptor.format -cne 'dinkster.control-runtime/1' -or
        $descriptor.commit -cne $expected.commit -or $descriptor.platform -cne $expected.platform -or
        $descriptor.python -cne $expected.python -or
        ($descriptor.invocation -join "`n") -cne ($expected.invocation -join "`n") -or
        $descriptor.artifact.path -cne $expected.artifact.path -or
        $descriptor.artifact.sha256 -cne $expected.artifact.sha256 -or
        $descriptor.artifact.size -ne $expected.artifact.size) {
        throw 'Installed control-runtime descriptor does not match the published release metadata'
    }
    $archive = Join-Path (Split-Path $descriptorPath) (Split-Path $descriptor.artifact.path -Leaf)
    Assert-Artifact @{ archive = (Split-Path $archive -Leaf); size = $descriptor.artifact.size; sha256 = $descriptor.artifact.sha256 } $archive
    @{ desktop = $desktop; controlRuntime = $descriptor; embeddedInputsVerified = $true } |
        ConvertTo-Json -Depth 8 | Set-Content (Join-Path $proof 'artifacts.json')
    "DINKSTER_DESKTOP_EXECUTABLE=$executable" >> $env:GITHUB_ENV
    "DINKSTER_DESKTOP_VERIFY_ROOT=$data" >> $env:GITHUB_ENV
    return
}

if (-not (Test-Path $owner)) { return }
$ownership = Get-Content $owner -Raw | ConvertFrom-Json
if ($ownership.install -cne $install -or $ownership.data -cne $data) { throw 'Verification ownership mismatch' }
function Get-OwnedProcesses {
    Get-CimInstance Win32_Process | Where-Object {
        $path = $_.ExecutablePath
        $path -and ($path.StartsWith("$install\", [StringComparison]::OrdinalIgnoreCase) -or
            $path.StartsWith("$data\", [StringComparison]::OrdinalIgnoreCase))
    }
}
$owned = @(Get-OwnedProcesses)
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $owned.ProcessId })
foreach ($process in $owned) {
    Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    Wait-Process -Id $process.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
}
$uninstaller = Join-Path $install 'Uninstall Dinkster Desktop.exe'
$exitCode = 0
if (Test-Path $uninstaller) {
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/currentuser /S' -Wait -PassThru
    $exitCode = $process.ExitCode
}
$command = "$protocol\shell\open\command"
$registration = 'absent or unrelated'
if ((Test-Path $command) -and (Get-Item $command).GetValue('') -ceq ('"' + $executable + '" "%1"')) {
    Remove-Item $protocol -Recurse -Force
    $registration = 'removed exact owned target'
}
$survivors = @(Get-OwnedProcesses)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $owned.ProcessId })
$lease = Test-Path (Join-Path $data 'data/engine/lifecycle.lock')
$clean = $exitCode -eq 0 -and -not (Test-Path $install) -and $survivors.Count -eq 0 -and $listeners.Count -eq 0 -and -not $lease
@{ clean = $clean; uninstallExit = $exitCode; survivors = $survivors.Count; listeners = $listeners.Count;
    observedPorts = @($ports.LocalPort); lifecycleLeasePresent = $lease; protocol = $registration } |
    ConvertTo-Json | Set-Content (Join-Path $proof 'cleanup.json')
if (-not $clean) { throw 'Owned installation cleanup failed; see cleanup.json' }
