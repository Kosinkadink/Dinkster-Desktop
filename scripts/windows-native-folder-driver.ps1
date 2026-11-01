[CmdletBinding()]
param(
  [Parameter(Mandatory)] [int] $RunnerPid,
  [Parameter(Mandatory)] [string] $HarnessStdoutPath,
  [Parameter(Mandatory)] [string] $EvidencePath,
  [Parameter(Mandatory)] [string] $LocalPath,
  [Parameter(Mandatory)] [string] $UncPath,
  [Parameter(Mandatory)] [string] $MappedDrive,
  [Parameter(Mandatory)] [string] $MapReadyPath,
  [Parameter(Mandatory)] [string] $MappedResultPath,
  [int] $TimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Path (Join-Path $PSScriptRoot 'windows-owned-picker.cs')

function Add-Evidence([string] $State, [hashtable] $Fields = @{}) {
  $record = [ordered]@{ timestamp = (Get-Date).ToString('o'); state = $State }
  foreach ($key in $Fields.Keys) { $record[$key] = $Fields[$key] }
  ($record | ConvertTo-Json -Depth 6 -Compress) | Add-Content -LiteralPath $EvidencePath -Encoding ascii
}

function Record-Control([IntPtr] $Dialog, $Control, [string] $Role) {
  $current = [OwnedPicker]::Validate($Dialog, $RunnerPid, $Control.Handle)
  if ($current.Id -ne $Control.Id -or $current.ClassName -cne $Control.ClassName -or $current.Text -cne $Control.Text) {
    throw 'Control changed before recorded action'
  }
  Add-Evidence 'validated-control' @{
    dialog = $Dialog.ToInt64(); handle = $current.Handle.ToInt64(); controlId = $current.Id
    className = $current.ClassName; text = $current.Text; role = $Role; ownerPid = $RunnerPid
  }
}

function Wait-Prompt([string] $Expected) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path -LiteralPath $HarnessStdoutPath) -and (Get-Content -LiteralPath $HarnessStdoutPath -Raw).Contains($Expected)) {
      Add-Evidence 'prompt-observed' @{ expectedPrompt = $Expected }
      return
    }
    Start-Sleep -Milliseconds 100
  }
  throw 'Expected harness prompt timed out'
}

function Find-Dialog {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $dialog = [OwnedPicker]::Dialog($RunnerPid)
    if ($dialog -ne [IntPtr]::Zero) {
      Add-Evidence 'validated-dialog' @{ handle = $dialog.ToInt64(); ownerPid = $RunnerPid; className = '#32770'; unique = $true }
      return $dialog
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw 'Unique owned folder dialog unavailable'
}

function Open-AddressEdit([IntPtr] $Dialog, $Toolbar) {
  Record-Control $Dialog $Toolbar 'address-toolbar'
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Dialog)
  if ($root.Current.ProcessId -ne $RunnerPid -or $root.Current.NativeWindowHandle -ne $Dialog.ToInt64()) { throw 'UIA dialog identity mismatch' }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $queue = [Collections.Generic.Queue[object]]::new()
  $queue.Enqueue($root)
  $matches = [Collections.Generic.List[object]]::new()
  $count = 0
  while ($queue.Count -gt 0) {
    $element = $queue.Dequeue()
    $count += 1
    if ($count -gt 512) { throw 'UIA tree exceeds bounded census' }
    if ($element.Current.ProcessId -eq $RunnerPid -and $element.Current.NativeWindowHandle -eq $Toolbar.Handle.ToInt64()) { $matches.Add($element) }
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child) {
      $queue.Enqueue($child)
      if ($queue.Count -gt 512) { throw 'UIA child census exceeds bound' }
      $child = $walker.GetNextSibling($child)
    }
  }
  if ($matches.Count -ne 1) { throw 'Unique rooted address toolbar UIA element unavailable' }
  $pattern = $null
  if (-not $matches[0].TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref] $pattern)) {
    throw 'Rooted address toolbar LegacyIAccessible pattern unavailable'
  }
  Record-Control $Dialog $Toolbar 'address-toolbar-default-action'
  ([System.Windows.Automation.LegacyIAccessiblePattern] $pattern).DoDefaultAction()
  Add-Evidence 'address-toolbar-default-action' @{}
}

function Select-ExactFolder([string] $ExpectedPath) {
  $dialog = Find-Dialog
  $controls = [OwnedPicker]::Controls($dialog, $RunnerPid)
  $facts = @($controls | ForEach-Object {
    @{ handle = $_.Handle.ToInt64(); controlId = $_.Id
       className = $(if ($_.ClassName -cin @('ToolbarWindow32', 'Address Band Root', 'Edit', 'Button', 'ComboBox', 'ComboBoxEx32', 'Breadcrumb Parent')) { $_.ClassName } else { 'other' })
       addressCaption = $_.Text.StartsWith('Address: ', [StringComparison]::Ordinal)
       selectCaption = ($_.Text.Replace('&', '') -ceq 'Select Folder'); cancelCaption = ($_.Text.Replace('&', '') -ceq 'Cancel') }
  })
  Add-Evidence 'native-control-census' @{ controls = $facts }
  $toolbars = @($controls | Where-Object { $_.ClassName -ceq 'ToolbarWindow32' -and $_.Text.StartsWith('Address: ', [StringComparison]::Ordinal) })
  if ($toolbars.Count -ne 1) { throw 'Unique named native address toolbar unavailable' }
  $toolbar = $toolbars[0]
  $band = [OwnedPicker]::AddressBand($dialog, $RunnerPid, $toolbar.Handle)
  Record-Control $dialog ([OwnedPicker]::Validate($dialog, $RunnerPid, $band)) 'address-band'
  Open-AddressEdit $dialog $toolbar
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $edit = [OwnedPicker]::AddressEdit($dialog, $RunnerPid, $band)
    if ($null -ne $edit) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  if ($null -eq $edit) { throw 'Unique address-band edit unavailable' }
  Record-Control $dialog $edit 'address-edit-set'
  [OwnedPicker]::SetAddress($dialog, $RunnerPid, $band, $edit, $ExpectedPath)
  $edit = [OwnedPicker]::Validate($dialog, $RunnerPid, $edit.Handle)
  Record-Control $dialog $edit 'address-edit-exact-readback'
  [OwnedPicker]::CommitAddress($dialog, $RunnerPid, $band, $edit)
  Add-Evidence 'address-navigation-invoked' @{ expectedPath = $ExpectedPath }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $committed = $null
  do {
    $current = [OwnedPicker]::Validate($dialog, $RunnerPid, $toolbar.Handle)
    if ($current.ClassName -cne 'ToolbarWindow32' -or $current.Id -ne $toolbar.Id) { throw 'Committed address control identity changed' }
    if ($current.Text -ceq "Address: $ExpectedPath") { $committed = $current; break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  if ($null -eq $committed) { throw 'Committed folder exact readback mismatch' }
  Record-Control $dialog $committed 'committed-folder-readback'
  Add-Evidence 'committed-folder-readback-confirmed' @{ expectedPath = $ExpectedPath; address = $committed.Text.Substring(9) }
  $button = [OwnedPicker]::Button($dialog, $RunnerPid, 'Select Folder')
  Record-Control $dialog $button 'select-folder'
  # Recheck the committed folder immediately before accepting it.
  if ([OwnedPicker]::Validate($dialog, $RunnerPid, $toolbar.Handle).Text -cne "Address: $ExpectedPath") { throw 'Committed folder changed before Select' }
  [OwnedPicker]::Click($dialog, $RunnerPid, $button)
  Add-Evidence 'select-folder-invoked' @{ expectedPath = $ExpectedPath }
}

function Drive-Command([string[]] $Arguments) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'net.exe'
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($start)
  $process.StandardInput.Close()
  $null = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
  $null = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'Owned drive command timed out; process left untouched' }
  if ($process.ExitCode -ne 0) { throw 'Owned drive command failed' }
}

$mapped = $false
Add-Evidence 'driver-started' @{ runnerPid = $RunnerPid }
try {
  Wait-Prompt "Select this folder in the native dialog: $LocalPath"
  Select-ExactFolder $LocalPath
  Wait-Prompt "Select this folder in the native dialog: $UncPath"
  Select-ExactFolder $UncPath
  if (Get-PSDrive -Name $MappedDrive.TrimEnd(':') -ErrorAction SilentlyContinue) { throw 'Owned drive letter already in use' }
  Drive-Command @('use', $MappedDrive, $UncPath, '/persistent:no')
  $mapped = $true
  Add-Evidence 'owned-drive-mapped' @{ drive = $MappedDrive; target = $UncPath }
  New-Item -ItemType File -Path $MapReadyPath | Out-Null
  Wait-Prompt "Select this folder in the native dialog: $MappedDrive\"
  Select-ExactFolder "$MappedDrive\"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path -LiteralPath $MappedResultPath)) {
    if ((Get-Date) -ge $deadline) { throw 'Mapped result acknowledgment timed out' }
    Start-Sleep -Milliseconds 100
  }
  Add-Evidence 'mapped-folder-result-acknowledged' @{}
  Drive-Command @('use', $MappedDrive, '/delete', '/y')
  $mapped = $false
  Add-Evidence 'owned-drive-unmapped' @{ drive = $MappedDrive }
  Wait-Prompt 'Cancel the next native folder dialog'
  $dialog = Find-Dialog
  $button = [OwnedPicker]::Button($dialog, $RunnerPid, 'Cancel')
  Record-Control $dialog $button 'cancel'
  [OwnedPicker]::Click($dialog, $RunnerPid, $button)
  Add-Evidence 'cancel-invoked-after-prompt' @{}
  Add-Evidence 'driver-completed' @{}
} catch {
  $failure = $_.Exception
  $fields = @{ exceptionType = $failure.GetType().FullName; hresult = $failure.HResult; sourceLine = $_.InvocationInfo.ScriptLineNumber }
  if ($null -ne $failure.InnerException) { $fields.innerExceptionType = $failure.InnerException.GetType().FullName; $fields.innerHresult = $failure.InnerException.HResult }
  Add-Evidence 'driver-operation-failed' $fields
  throw
} finally {
  if ($mapped) {
    Drive-Command @('use', $MappedDrive, '/delete', '/y')
    Add-Evidence 'owned-drive-unmapped' @{ drive = $MappedDrive }
  }
}
