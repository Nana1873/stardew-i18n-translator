param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][int]$OwnerProcessId
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target/desktop-e2e/runs')).TrimEnd('\') + '\'
$runRoot = [IO.Path]::GetFullPath($env:SIT_E2E_RUN_DIR)
$exePath = [IO.Path]::GetFullPath($Executable)
if (!$runRoot.StartsWith($runsRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $exePath -ne (Join-Path $runRoot 'runtime/app/stardew-i18n-translator.exe')) {
    throw 'Profile probes require the supervisor-owned application.'
}
$owner = [Diagnostics.Process]::GetProcessById($OwnerProcessId)
$null = $owner.Handle
if ($owner.HasExited -or $owner.MainModule.FileName -ne $exePath) {
    throw 'The profile owner is not the expected running test application.'
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ProfileNative {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
}
'@
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $exePath
$start.WorkingDirectory = [IO.Path]::GetDirectoryName($exePath)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$child = $null
try {
    $child = [Diagnostics.Process]::Start($start)
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if ($child.HasExited) { throw 'The second instance exited without showing its profile warning.' }
        $child.Refresh()
        if ($child.MainWindowHandle -ne [IntPtr]::Zero) {
            $window = [System.Windows.Automation.AutomationElement]::FromHandle($child.MainWindowHandle)
            if ($window.Current.Name -eq 'Portable profile unavailable') { break }
        }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'The second instance did not show the ownership warning.' }
        Start-Sleep -Milliseconds 100
    } while ($true)
    $elements = @($window.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition))
    $names = @($elements | ForEach-Object { $_.Current.Name })
    if (@($names | Where-Object { $_ -like '*Close another Translator using this folder*' }).Count -eq 0) {
        throw 'The ownership warning did not explain how to recover.'
    }
    $elements | ForEach-Object {
        @{ name = $_.Current.Name; type = $_.Current.ControlType.ProgrammaticName; pid = $_.Current.ProcessId; handle = $_.Current.NativeWindowHandle; automationId = $_.Current.AutomationId }
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'profile-owner-warning-ui.json') -Encoding UTF8
    $buttons = @($elements | Where-Object { $_.Current.Name -eq 'OK' })
    if ($window.Current.ProcessId -ne $child.Id -or $buttons.Count -ne 1) {
        throw 'The owned profile warning has no OK button.'
    }
    $button = [IntPtr]$buttons[0].Current.NativeWindowHandle
    [uint32]$buttonOwner = 0
    $null = [ProfileNative]::GetWindowThreadProcessId($button, [ref]$buttonOwner)
    if ($button -eq [IntPtr]::Zero -or $buttonOwner -ne $child.Id) {
        throw 'The OK control does not belong to the rejected test instance.'
    }
    $messageResult = [IntPtr]::Zero
    if ([ProfileNative]::SendMessageTimeout($button, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero, 2, 3000, [ref]$messageResult) -eq [IntPtr]::Zero) {
        throw 'The profile warning did not accept OK.'
    }
    if (!$child.WaitForExit(10000) -or $child.ExitCode -ne 0) {
        throw 'The rejected instance did not exit normally.'
    }
    if ($owner.HasExited) { throw 'The original profile owner was stopped.' }
    @{ passed = $true; rejectedPid = $child.Id; ownerPid = $owner.Id; exitCode = $child.ExitCode } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $child) {
        if (!$child.HasExited) { $child.Kill(); $null = $child.WaitForExit(10000) }
        $child.Dispose()
    }
    $owner.Dispose()
}
