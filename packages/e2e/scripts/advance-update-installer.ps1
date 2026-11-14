param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Installer interaction requires a disposable GitHub-hosted runner'
}
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class InstallerWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$deadline = [DateTime]::UtcNow.AddMinutes(3)
while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($process in Get-Process) {
        if ($process.MainWindowHandle -eq 0 -or $process.MainWindowTitle -notlike 'Dinkster Desktop*Setup*') { continue }
        $cachePath = Join-Path $env:LOCALAPPDATA '@dinksterdesktop-updater\'
        if (-not $process.Path.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase) -and
            -not $process.Path.StartsWith($cachePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $button = [InstallerWindow]::GetDlgItem($process.MainWindowHandle, 1)
        if ($button -ne [IntPtr]::Zero -and [InstallerWindow]::IsWindowEnabled($button)) {
            # Exercise the real assisted installer's Next/Install/Finish button.
            [InstallerWindow]::SendMessage($process.MainWindowHandle, 0x111, [IntPtr]1, $button) | Out-Null
            "$($process.Id) $($process.MainWindowTitle)" | Add-Content (Join-Path $Root 'installer-buttons.txt')
        }
    }
    Start-Sleep -Milliseconds 250
}
