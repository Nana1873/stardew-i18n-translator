param(
    [Parameter(Mandatory = $true)][int]$AppProcessId,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][ValidateSet('pick', 'save', 'cancel', 'close', 'inspect', 'metrics')][string]$Action,
    [string]$Title,
    [string]$Path
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target/desktop-e2e/runs')).TrimEnd('\') + '\'
$runRoot = [IO.Path]::GetFullPath($env:SIT_E2E_RUN_DIR)
$testRuntime = [IO.Path]::GetFullPath((Join-Path $runRoot 'runtime')).TrimEnd('\') + '\'
if (!$runRoot.StartsWith($runsRoot, [StringComparison]::OrdinalIgnoreCase) -or
    ![IO.Path]::GetFullPath($Executable).StartsWith($testRuntime, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Native helpers require an executable in the supervisor-owned runtime.'
}
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DesktopNative {
    public delegate bool WindowCallback(IntPtr handle, IntPtr argument);
    [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback, IntPtr argument);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr argument);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr handle);
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr handle, int id);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder name, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wparam, string lparam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
    public static IntPtr Dialog(int pid, string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr handle, IntPtr unused) {
            uint owner; GetWindowThreadProcessId(handle, out owner);
            if (owner != pid) return true;
            var kind = new StringBuilder(256); GetClassName(handle, kind, kind.Capacity);
            var text = new StringBuilder(1024); GetWindowText(handle, text, text.Capacity);
            if (kind.ToString() == "#32770" && text.ToString() == title) { found = handle; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static IntPtr PathEdit(IntPtr dialog, bool save) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(dialog, delegate(IntPtr handle, IntPtr unused) {
            int id = GetDlgCtrlID(handle);
            var kind = new StringBuilder(256); GetClassName(handle, kind, kind.Capacity);
            if ((id == 1152 || id == 1148 || (save && id == 1001)) && kind.ToString() == "Edit") { found = handle; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$app = Get-Process -Id $AppProcessId -ErrorAction Stop
if (![string]::Equals($app.Path, [IO.Path]::GetFullPath($Executable), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to operate on a process outside this test application.'
}
if ($Action -eq 'metrics') {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($app.MainWindowHandle -eq [IntPtr]::Zero) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'No application window for native DPI measurement.' }
        Start-Sleep -Milliseconds 100
        $app.Refresh()
    }
    $dpi = [DesktopNative]::GetDpiForWindow($app.MainWindowHandle)
    if (!$dpi) { throw 'Native DPI measurement failed.' }
    @{
        dpi = $dpi
        awareness = [DesktopNative]::GetAwarenessFromDpiAwarenessContext([DesktopNative]::GetWindowDpiAwarenessContext($app.MainWindowHandle))
        workingSetBytes = $app.WorkingSet64
        privateBytes = $app.PrivateMemorySize64
        cpuSeconds = $app.TotalProcessorTime.TotalSeconds
        handles = $app.HandleCount
    } | ConvertTo-Json -Compress
    exit 0
}
if ($Action -eq 'close') {
    if (!$app.CloseMainWindow()) { throw 'The application did not accept its normal window-close request.' }
    if (!$app.WaitForExit(15000)) { throw 'The application did not exit after its window-close request.' }
    Write-Output 'Application exited after normal window close.'
    exit 0
}
if ($Action -eq 'inspect') {
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
    $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
        ForEach-Object { $_.Current | Select-Object Name,ClassName,AutomationId } | ConvertTo-Json -Depth 3
    exit 0
}
if (!$Title) { throw 'A specific native dialog title is required.' }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$dialog = [IntPtr]::Zero
while ($dialog -eq [IntPtr]::Zero) {
    $dialog = [DesktopNative]::Dialog($AppProcessId, $Title)
    if ([DateTime]::UtcNow -gt $deadline) { throw "Native dialog did not appear: $Title" }
    if ($dialog -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
$savePath = $Action -eq 'save' -or ($Action -eq 'cancel' -and $Path)
if ($Action -eq 'pick' -or $savePath) {
    if (![IO.Path]::IsPathRooted($Path)) { throw 'Picker input must be an absolute fixture path.' }
    $fixtureRoot = $testRuntime
    if (![IO.Path]::GetFullPath($Path).StartsWith($fixtureRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Picker input must stay inside this test runtime.' }
    if ($Action -eq 'pick' -and !(Test-Path -LiteralPath $Path)) { throw 'Open picker input must exist.' }
    if ($savePath -and ((Test-Path -LiteralPath $Path) -or !(Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($Path)) -PathType Container))) {
        throw 'Save picker input must be new, with an existing fixture parent directory.'
    }
    # Standard Windows common-dialog IDs, observed through its accessibility tree.
    # UIA ValuePattern/InvokePattern are unavailable for these controls on some
    # Windows builds. Target the actual native controls, without focus or keys.
    $edit = [DesktopNative]::PathEdit($dialog, $savePath)
    if ($edit -eq [IntPtr]::Zero -and $savePath) {
        # Modern Save dialogs expose the filename as a DirectUI Edit (1001),
        # which may have no HWND. Use its actual accessibility ValuePattern.
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
        $window = [System.Windows.Automation.AutomationElement]::FromHandle($dialog)
        $condition = New-Object System.Windows.Automation.AndCondition(
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')),
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Edit'))
        )
        $field = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        if ($null -eq $field) { throw 'The native Save filename control is unavailable.' }
        $value = $field.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $value.SetValue($Path)
        if ($value.Current.Value -ne $Path) { throw 'The native Save filename did not update.' }
    } elseif ($edit -eq [IntPtr]::Zero) { throw 'The common dialog path control (1152/1148) is unavailable.' }
    else {
        $messageResult = [IntPtr]::Zero
        if ([DesktopNative]::SendMessageTimeout($edit, 0x000C, [IntPtr]::Zero, $Path, 2, 5000, [ref]$messageResult) -eq [IntPtr]::Zero) {
            throw 'The native dialog did not accept its path text.'
        }
    }
}
$buttonId = if ($Action -eq 'cancel') { 2 } else { 1 }
$button = [DesktopNative]::GetDlgItem($dialog, $buttonId)
if ($button -eq [IntPtr]::Zero -or ![DesktopNative]::IsWindowEnabled($button)) { throw 'The common dialog action is unavailable.' }
if (![DesktopNative]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not activate the native dialog button.' }
while ([DesktopNative]::IsWindow($dialog)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw "Native dialog did not complete: $Title" }
    Start-Sleep -Milliseconds 100
}
Write-Output "$Action completed: $Title"
