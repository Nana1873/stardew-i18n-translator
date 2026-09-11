param(
    [ValidateSet('none', 'assertion', 'exit')][string]$FailureProbe = 'none',
    [string]$ReleaseZip
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runsRoot = Join-Path $repoRoot 'target/desktop-e2e/runs'
$runRoot = Join-Path $runsRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$runtimeRoot = Join-Path $runRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Write-Host "Desktop E2E artifacts: $runRoot"
$job = $null
$child = $null
$stdout = $null
$stderr = $null
$result = 1
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'job.cs')
    if (![DesktopTestJob]::HasInteractiveDesktop()) { throw 'Desktop E2E requires a logged-in, unlocked Windows desktop, not a service session.' }
    $job = New-Object DesktopTestJob
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command node.exe -ErrorAction Stop).Source
    $start.Arguments = '"' + (Join-Path $PSScriptRoot 'workflow.mjs') + '"'
    $start.WorkingDirectory = $repoRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['SIT_E2E_RUN_DIR'] = $runRoot
    $start.EnvironmentVariables['SIT_E2E_FAILURE_PROBE'] = $FailureProbe
    if ($ReleaseZip) {
        $start.EnvironmentVariables['SIT_E2E_RELEASE_ZIP'] = (Resolve-Path -LiteralPath $ReleaseZip -ErrorAction Stop).Path
    } else {
        $start.EnvironmentVariables.Remove('SIT_E2E_RELEASE_ZIP')
    }
    $child = [Diagnostics.Process]::Start($start)
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    # Node cannot launch any children until assignment succeeds.
    $job.Assign($child.Handle)
    $child.StandardInput.WriteLine('go')
    $child.StandardInput.Close()
    $deadline = [DateTime]::UtcNow.AddMinutes(20)
    while (!$child.WaitForExit(200)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Desktop E2E exceeded its 20-minute build/run watchdog.' }
    }
    $result = $child.ExitCode
} catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $runRoot 'supervisor-error.log')
    Write-Warning $_
} finally {
    $owned = @()
    if ($null -ne $job) {
        try {
            foreach ($ownedId in $job.ProcessIds()) {
                try {
                    $ownedProcess = [Diagnostics.Process]::GetProcessById($ownedId)
                    $null = $ownedProcess.Handle # Retain identity; do not act on a reused PID.
                    $owned += $ownedProcess
                } catch { } # Process already exited.
            }
        } catch {
            Write-Warning "Could not inventory the test job: $_"
            $result = 1
        } finally {
            $job.Dispose()
        }
    }
    $processCleanup = @()
    foreach ($ownedProcess in $owned) {
        $exited = $ownedProcess.WaitForExit(10000)
        $processCleanup += @{ id = $ownedProcess.Id; exited = $exited }
        if (!$exited) { $result = 1 }
        $ownedProcess.Dispose()
    }
    if ($null -ne $child) {
        if (!$child.HasExited) { $child.Kill() }
        $null = $child.WaitForExit(10000)
        if ($null -ne $stdout -and $stdout.Wait(10000)) {
            $stdout.Result | Set-Content -LiteralPath (Join-Path $runRoot 'stdout.log')
            Write-Host $stdout.Result
        }
        if ($null -ne $stderr -and $stderr.Wait(10000)) {
            $stderr.Result | Set-Content -LiteralPath (Join-Path $runRoot 'stderr.log')
            if ($stderr.Result) { Write-Host $stderr.Result }
        }
        $child.Dispose()
    }
    # Preserve backend diagnostics even when Node exits before its own finally.
    $appLogs = Join-Path $runtimeRoot 'app/data/logs'
    if (Test-Path -LiteralPath $appLogs) {
        try {
            $savedLogs = Join-Path $runRoot 'app-logs'
            New-Item -ItemType Directory -Force -Path $savedLogs | Out-Null
            Get-ChildItem -LiteralPath $appLogs -File | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $savedLogs $_.Name) -Force
            }
        } catch {
            Write-Warning "Could not preserve backend logs: $_"
            $result = 1
        }
    }
    # Delete only this generated runtime directory, never a caller-supplied path.
    $resolvedRuntime = [IO.Path]::GetFullPath($runtimeRoot)
    $expectedParent = [IO.Path]::GetFullPath($runsRoot).TrimEnd('\') + '\'
    if (!$resolvedRuntime.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedRuntime) -ne 'runtime') {
        throw "Refusing cleanup outside the generated test runtime: $resolvedRuntime"
    }
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (Test-Path -LiteralPath $resolvedRuntime) {
        try { Remove-Item -LiteralPath $resolvedRuntime -Recurse -Force -ErrorAction Stop }
        catch {
            if ([DateTime]::UtcNow -gt $cleanupDeadline) {
                $_ | Out-String | Set-Content -LiteralPath (Join-Path $runRoot 'cleanup-error.log')
                Write-Warning "Cleanup failed; see $runRoot\cleanup-error.log"
                $result = 1
                break
            }
            Start-Sleep -Milliseconds 200 # Retry only while Windows still holds files.
        }
    }
    @{ runtimeRemoved = !(Test-Path -LiteralPath $resolvedRuntime); exitCode = $result; ownedProcesses = $processCleanup } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'cleanup.json')
}
exit $result
