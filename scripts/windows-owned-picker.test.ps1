Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-owned-picker.cs') -Raw
Add-Type -TypeDefinition $source
$fakeBoundary = @'
    public static int Case;
    public static int Writes;
    public static int Clicks;
    public static string Path = @"C:\old";
    public static string Committed = @"C:\old";
    private static class Native {
        internal static bool EnumWindows(Callback callback, IntPtr data) {
            callback(new IntPtr(10), data);
            if (Case == 1) callback(new IntPtr(20), data);
            return true;
        }
        internal static bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr data) {
            foreach (int handle in new int[] { 11, 12, 13, 14, 15, 16 })
                if (!callback(new IntPtr(handle), data)) return false;
            return true;
        }
        internal static uint GetWindowThreadProcessId(IntPtr window, out uint pid) {
            pid = Case == 2 && window.ToInt32() == 14 ? 99u : 37u;
            return 1;
        }
        internal static int GetClassNameW(IntPtr window, StringBuilder text, int capacity) {
            string value;
            switch (window.ToInt32()) {
                case 10: case 20: value = "#32770"; break;
                case 11: value = "Address Band Root"; break;
                case 12: value = "ToolbarWindow32"; break;
                case 13: case 16: value = "Edit"; break;
                default: value = Case == 3 ? "Edit" : "Button"; break;
            }
            text.Append(value); return value.Length;
        }
        internal static IntPtr ReadText(IntPtr window, uint message, IntPtr capacity, StringBuilder text, uint flags, uint timeout, out IntPtr result) {
            string value = "";
            switch (window.ToInt32()) {
                case 12: value = "Address: " + Committed; break;
                case 13: value = Path; break;
                case 14: value = "Select &Folder"; break;
                case 15: value = "Cancel"; break;
            }
            text.Append(value); result = new IntPtr(value.Length); return new IntPtr(1);
        }
        internal static bool IsChild(IntPtr parent, IntPtr child) {
            if (parent.ToInt32() == 10) return child.ToInt32() >= 11 && child.ToInt32() <= 16 && !(Case == 4 && child.ToInt32() == 14);
            return parent.ToInt32() == 11 && (child.ToInt32() == 13 || (Case == 5 && child.ToInt32() == 16));
        }
        internal static int GetDlgCtrlID(IntPtr child) { return child.ToInt32() * 17 + (Case == 6 ? 1 : 0); }
        internal static IntPtr GetParent(IntPtr child) { return new IntPtr(child.ToInt32() == 12 ? 11 : 10); }
        internal static IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam, string value, uint flags, uint timeout, out IntPtr result) {
            if (window.ToInt32() != 13 || message != 0x000C) throw new InvalidOperationException("Wrong write target");
            Writes++; Path = Case == 7 ? @"C:\wrong" : value; result = new IntPtr(1); return result;
        }
        internal static IntPtr SendNumeric(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result) {
            if (message == 0x00F5 && (window.ToInt32() == 14 || window.ToInt32() == 15)) { Clicks++; }
            else throw new InvalidOperationException("Wrong message target");
            result = new IntPtr(1); return result;
        }
        internal static bool PostNumeric(IntPtr window, uint message, IntPtr wParam, IntPtr lParam) {
            if (window.ToInt32() != 13 || wParam.ToInt32() != 13 || (message != 0x0100 && message != 0x0101))
                throw new InvalidOperationException("Wrong queued navigation target");
            if (message == 0x0100) Committed = Case == 8 ? @"C:\wrong" : Path;
            return true;
        }
    }
'@
$pattern = '(?s)    private static class Native \{.*?    // End native boundary\.'
if ([regex]::Matches($source, $pattern).Count -ne 1) { throw 'Native boundary not unique' }
$fake = [regex]::Replace($source, $pattern, [System.Text.RegularExpressions.MatchEvaluator] { param($match) $fakeBoundary })
$fake = $fake.Replace('public static class OwnedPicker {', 'public static class FakePicker {')
if ($fake.Contains('DllImport')) { throw 'Fake retains native calls' }
Add-Type -TypeDefinition $fake
function Assert-Rejected([scriptblock] $Action) {
  $rejected = $false
  try { & $Action } catch { $rejected = $true }
  if (-not $rejected) { throw 'Unsafe input was accepted' }
}
$dialog = [IntPtr]::new(10)
$band = [IntPtr]::new(11)
$button = [FakePicker]::Button($dialog, 37, 'Select Folder')
if ($button.Handle.ToInt32() -ne 14 -or $button.Id -ne 238) { throw 'Live ID or named button mismatch' }
[FakePicker]::Click($dialog, 37, $button)
if ([FakePicker]::Clicks -ne 1) { throw 'Valid click missing' }
foreach ($case in @(1, 2, 3, 4, 6)) {
  [FakePicker]::Case = $case
  Assert-Rejected { [FakePicker]::Click($dialog, 37, $button) }
}
if ([FakePicker]::Clicks -ne 1) { throw 'Rejected identity sent input' }
[FakePicker]::Case = 5
Assert-Rejected { [FakePicker]::AddressEdit($dialog, 37, $band) }
[FakePicker]::Case = 0
if ([FakePicker]::AddressBand($dialog, 37, [IntPtr]::new(12)) -ne $band) { throw 'Address ancestry mismatch' }
$edit = [FakePicker]::AddressEdit($dialog, 37, $band)
if ($edit.Handle.ToInt32() -ne 13) { throw 'Unrelated edit selected' }
[FakePicker]::SetAddress($dialog, 37, $band, $edit, 'C:\asymmetric folder')
$edit = [FakePicker]::Validate($dialog, 37, $edit.Handle)
[FakePicker]::CommitAddress($dialog, 37, $band, $edit)
if ([FakePicker]::Committed -cne 'C:\asymmetric folder') { throw 'Exact address commit missing' }
[FakePicker]::Case = 7
Assert-Rejected { [FakePicker]::SetAddress($dialog, 37, $band, $edit, 'C:\different') }

# Execute the driver's actual selection function with only native/UIA boundaries replaced.
$driver = Join-Path $PSScriptRoot 'windows-native-folder-driver.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($driver, [ref] $tokens, [ref] $errors)
if ($errors.Count -ne 0) { throw 'Driver parser errors' }
foreach ($name in @('Record-Control', 'Select-ExactFolder')) {
  $definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
  if ($definitions.Count -ne 1) { throw 'Function extraction is not unique' }
  . ([scriptblock]::Create($definitions[0].Extent.Text.Replace('[OwnedPicker]', '[FakePicker]')))
}
function Find-Dialog { return [IntPtr]::new(10) }
function Open-AddressEdit { }
function Add-Evidence([string] $State, [hashtable] $Fields) { $script:states.Add($State) }
$RunnerPid = 37
$TimeoutSeconds = 0
$script:states = [Collections.Generic.List[string]]::new()
[FakePicker]::Case = 0
Select-ExactFolder 'C:\native test folder'
if ([FakePicker]::Clicks -ne 2 -or -not $states.Contains('committed-folder-readback-confirmed')) { throw 'Exact committed selection missing' }
[FakePicker]::Case = 8
Assert-Rejected { Select-ExactFolder 'C:\other folder' }
if ([FakePicker]::Clicks -ne 2) { throw 'Readback mismatch clicked Select' }
@{ result = 'owned-picker-benign-passed'; originalCompiledOnly = $true; nativeCalls = 0; identityRejections = 5; ambiguousEditRejected = $true; unrelatedEditIgnored = $true; exactEditMismatchRejected = $true; committedMismatchDidNotSelect = $true } | ConvertTo-Json -Compress
