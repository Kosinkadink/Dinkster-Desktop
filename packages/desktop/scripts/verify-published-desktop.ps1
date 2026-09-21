param([Parameter(Mandatory)][ValidateSet('DownloadBackend', 'DownloadDesktop', 'Install', 'Cleanup')][string]$Action)

$ErrorActionPreference = 'Stop'
if ($Action.StartsWith('Download') -and -not $env:GH_TOKEN) {
    throw 'Missing dedicated acquisition token; no fallback token is permitted'
}
if (-not $env:DINKSTER_VERIFY_WORK) { throw 'Set DINKSTER_VERIFY_WORK to a new isolated verification directory' }
$root = [IO.Path]::GetFullPath($env:DINKSTER_VERIFY_WORK)
$assets = Join-Path $root 'assets'
$proof = Join-Path $root 'proof'
$install = Join-Path $root 'app'
$data = Join-Path $root 'run'
$owner = Join-Path $root 'owned-install.json'
$desktop = Get-Content (Join-Path $PSScriptRoot 'published-desktop.json') -Raw | ConvertFrom-Json
if (-not $env:DINKSTER_PUBLISHED_SOURCE) { throw 'Set DINKSTER_PUBLISHED_SOURCE to the published frontend checkout' }
$backend = Get-Content (Join-Path $env:DINKSTER_PUBLISHED_SOURCE 'packages/desktop/src/backend-release.json') -Raw | ConvertFrom-Json
$aimdo = $backend.desktopWindowsRuntime.aimdo
if ($desktop.published -ne $true -and $Action -ne 'Cleanup') {
    throw 'No Dinkster Desktop release has been published'
}
if ($desktop.published -eq $true -and ($backend.commit -cne $desktop.backendCommit -or $backend.releaseTag -cne "backend-$($desktop.backendCommit)")) {
    throw 'The published Desktop verifier requires its original backend pin'
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

if ($Action -eq 'DownloadBackend') {
    if (Test-Path -LiteralPath $root) { throw 'Verification directory must be fresh' }
    New-Item -ItemType Directory -Path $assets, $proof | Out-Null
    Get-ReleaseArtifact $backend
    Get-ReleaseArtifact $aimdo
    "DINKSTER_ENGINE_ARCHIVE=$(Join-Path $assets $backend.archive)" >> $env:GITHUB_ENV
    "DINKSTER_AIMDO_WHEEL=$(Join-Path $assets $aimdo.archive)" >> $env:GITHUB_ENV
    return
}
if ($Action -eq 'DownloadDesktop') {
    Get-ReleaseArtifact $desktop
    return
}

# Installation and cleanup must not inherit acquisition credentials, even locally.
Get-ChildItem Env: | Where-Object { $_.Name -match 'TOKEN|SECRET|PASSWORD|CREDENTIAL|^GIT_' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" }
$protocol = 'Registry::HKEY_CURRENT_USER\Software\Classes\dinkster'
$executable = Join-Path $install 'Dinkster Desktop.exe'
if ($Action -eq 'Install') {
    foreach ($pin in @($desktop, $backend, $aimdo)) { Assert-Artifact $pin (Join-Path $assets $pin.archive) }
    if ((Test-Path $install) -or (Test-Path $data) -or (Test-Path $owner) -or (Test-Path $protocol)) {
        throw 'Refusing to overwrite an existing installation, protocol, or verification environment'
    }
    $existing = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall -ErrorAction SilentlyContinue |
        Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Dinkster Desktop' }
    if ($existing) { throw 'Use a runner without an existing Dinkster Desktop installation' }
    @{ install = $install; data = $data } | ConvertTo-Json | Set-Content $owner
    $process = Start-Process -FilePath (Join-Path $assets $desktop.archive) -ArgumentList @('/S', '/currentuser', '/NODESKTOPSHORTCUT', "/D=$install") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
    foreach ($pin in @($backend, $aimdo)) { Assert-Artifact $pin (Join-Path $install "resources/engine/$($pin.archive)") }
    @{ desktop = $desktop; backend = $backend; embeddedInputsVerified = $true; accelerator = 'cpu' } |
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
