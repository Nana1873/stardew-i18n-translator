param([string]$Fixture = 'target/mod-manager-probe/run-340cbe86bed94153aeaff6cb5b6bfb42/input')
$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$exe = Join-Path $workspaceRoot 'target/vortex-state-probe/build/release/vortex-state-probe.exe'
$fixturePath = (Resolve-Path -LiteralPath (Join-Path $workspaceRoot $Fixture)).Path
$results = @()
foreach ($case in @('normal', 'native-table', 'unknown-fields', 'corrupt-current', 'corrupt-table', 'invalid-json', 'invalid-state', 'escape-path')) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $exe
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($case -ne 'normal') {
        $startInfo.ArgumentList.Add('--case')
        $startInfo.ArgumentList.Add($case)
    }
    $startInfo.ArgumentList.Add($fixturePath)
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    [void]$process.Start()
    $peak = 0L
    while (-not $process.WaitForExit(20)) {
        $process.Refresh()
        $peak = [Math]::Max($peak, $process.PeakWorkingSet64)
    }
    $watch.Stop()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $successExpected = $case -in @('normal', 'native-table', 'unknown-fields')
    if (($process.ExitCode -eq 0) -ne $successExpected) { throw "Unexpected result for ${case}: $stdout $stderr" }
    if ($successExpected) { $detail = $stdout | ConvertFrom-Json }
    else {
        $detail = $stderr | ConvertFrom-Json
        if ($detail.error -notlike '*immutable input hashes unchanged*') { throw "Missing input integrity proof: $case" }
    }
    if (($stdout + $stderr).Contains('PROBE_SECRET_SENTINEL')) { throw 'Unknown field leaked' }
    $results += [pscustomobject]@{ case=$case; exitCode=$process.ExitCode; wallSeconds=$watch.Elapsed.TotalSeconds; sampledPeakWorkingSetBytes=$peak; detail=$detail }
    $process.Dispose()
}
$report = Join-Path $workspaceRoot 'target/vortex-state-probe/verification.json'
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $report
$results | Select-Object case,exitCode,wallSeconds,sampledPeakWorkingSetBytes | Format-Table
Write-Output "Evidence: $report"
