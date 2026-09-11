param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][ValidateSet('normal', 'missing-runtime')][string]$Mode
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target/desktop-e2e/runs')).TrimEnd('\') + '\'
$runRoot = [IO.Path]::GetFullPath($env:SIT_E2E_RUN_DIR)
$exePath = [IO.Path]::GetFullPath($Executable)
if (!$runRoot.StartsWith($runsRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $exePath -ne (Join-Path $runRoot 'runtime/startup/runtime/app/stardew-i18n-translator.exe')) {
    throw 'Startup probes must use the generated startup installation.'
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StartupNative {
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
$null = [StartupNative]::SetProcessDPIAware()
function Save-WindowImage($window, [string]$name) {
    $rect = $window.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { throw 'No window bounds for screenshot.' }
    $bitmap = New-Object Drawing.Bitmap ([int]$rect.Width), ([int]$rect.Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $dc = $graphics.GetHdc()
    try { $captured = [StartupNative]::PrintWindow([IntPtr]$window.Current.NativeWindowHandle, $dc, 2) }
    finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
    try {
        if (!$captured) { throw 'PrintWindow could not capture the application.' }
        $bitmap.Save((Join-Path $runRoot $name), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
}
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $exePath
$start.WorkingDirectory = [IO.Path]::GetDirectoryName($exePath)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
foreach ($key in @($start.EnvironmentVariables.Keys)) {
    if ($key -match '^(WEBVIEW2_|TAURI_|NODE_|NEXUS_API_KEY$)') { $start.EnvironmentVariables.Remove($key) }
}
# The application must start without Rust/Node/Codex/build-tool search paths or
# a WebDriver/debug-port launch. This is a host test, not a clean Windows claim.
$start.EnvironmentVariables['PATH'] = "$env:WINDIR\System32;$env:WINDIR"
foreach ($pair in @{
    'TEMP' = 'temp'; 'TMP' = 'temp'; 'APPDATA' = 'roaming'; 'LOCALAPPDATA' = 'local'
    'WEBVIEW2_USER_DATA_FOLDER' = 'webview'
}.GetEnumerator()) {
    $directory = Join-Path $runRoot ('runtime/startup/' + $pair.Value)
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $start.EnvironmentVariables[$pair.Key] = $directory
}
if ($Mode -eq 'missing-runtime') {
    $emptyRuntime = Join-Path $runRoot 'runtime/startup/empty-webview-runtime'
    New-Item -ItemType Directory -Path $emptyRuntime -Force | Out-Null
    # Microsoft's documented per-process loader override exercises the actual
    # missing-runtime bootstrap without uninstalling the host's shared runtime.
    $start.EnvironmentVariables['WEBVIEW2_BROWSER_EXECUTABLE_FOLDER'] = $emptyRuntime
}
$process = $null
$window = $null
$names = @()
try {
    $process = [Diagnostics.Process]::Start($start)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if ($process.HasExited) { throw "App exited before startup was verified: $($process.ExitCode)" }
        $process.Refresh()
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            $names = @($window.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name })
            $ready = if ($Mode -eq 'normal') { $names -contains 'Stardew Valley folder' } else {
                $window.Current.Name -eq 'Microsoft Edge WebView2 is required' -and
                @($names | Where-Object { $_ -like '*Nothing will be downloaded or installed automatically*' -and $_ -like '*https://developer.microsoft.com/en-us/microsoft-edge/webview2/*' }).Count -gt 0
            }
            if ($ready) { break }
        }
        if ([DateTime]::UtcNow -gt $deadline) { throw "Startup surface not found: $Mode" }
        Start-Sleep -Milliseconds 100 # Poll the actual accessible startup state.
    } while ($true)
    $names | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot "startup-$Mode-ui.json") -Encoding UTF8
    Save-WindowImage $window "startup-$Mode.png"
    if ($Mode -eq 'missing-runtime') {
        $no = [StartupNative]::GetDlgItem($process.MainWindowHandle, 7) # IDNO, locale independent.
        [uint32]$owner = 0
        $null = [StartupNative]::GetWindowThreadProcessId($no, [ref]$owner)
        if ($no -eq [IntPtr]::Zero -or $owner -ne $process.Id -or ![StartupNative]::IsWindowEnabled($no)) { throw 'The owned dependency dialog has no enabled No button.' }
        $messageResult = [IntPtr]::Zero
        if ([StartupNative]::SendMessageTimeout($no, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero, 2, 3000, [ref]$messageResult) -eq [IntPtr]::Zero) { throw 'The dependency dialog did not accept No.' }
    } elseif (!$process.CloseMainWindow()) { throw 'The application refused normal close.' }
    if (!$process.WaitForExit(15000)) { throw 'The startup application did not exit normally.' }
    if ($process.ExitCode -ne 0) { throw "Unexpected startup exit code: $($process.ExitCode)" }
    @{ passed = $true; mode = $Mode; pid = $process.Id; exitCode = $process.ExitCode; pathRestricted = $true; webdriver = $false; cleanWindows = $false } | ConvertTo-Json -Compress
} catch {
    $names | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot "startup-$Mode-failure-ui.json") -Encoding UTF8
    if ($null -ne $window) { try { Save-WindowImage $window "startup-$Mode-failure.png" } catch { Write-Warning $_ } }
    throw
} finally {
    if ($null -ne $process) {
        if (!$process.HasExited) { $process.Kill(); $null = $process.WaitForExit(10000) }
        $process.Dispose()
    }
    # The outer supervisor also owns this helper and every WebView descendant.
}
