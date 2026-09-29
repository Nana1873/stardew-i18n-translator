$ErrorActionPreference = 'Stop'
$prototypeRoot = Join-Path $PSScriptRoot 'chatgpt-login-prototype'
$runtimeRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'target\chatgpt-login-prototype'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$serverScript = Join-Path $prototypeRoot 'server.mjs'
$runtimeFile = Join-Path $runtimeRoot 'runtime.json'
if (Test-Path -LiteralPath $runtimeFile) {
    $existingRuntime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$existingRuntime.pid)" -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.ExecutablePath -eq $nodeExe -and $existingProcess.CommandLine.Contains($serverScript) -and $existingRuntime.url -match '^http://127\.0\.0\.1:[0-9]+$') {
        Start-Process -FilePath $existingRuntime.url
        exit 0
    }
}
$prototypeArgs = '"' + $serverScript + '" --open'
$prototypeProcess = Start-Process -FilePath $nodeExe -ArgumentList $prototypeArgs -WorkingDirectory $prototypeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'stderr.log') -PassThru
for ($attemptIndex = 0; $attemptIndex -lt 25; $attemptIndex++) {
    Start-Sleep -Milliseconds 200
    if ($prototypeProcess.HasExited) {
        throw 'The prototype could not start. Check target/chatgpt-login-prototype/stderr.log.'
    }
    if (Test-Path -LiteralPath $runtimeFile) {
        $newRuntime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        if ([int]$newRuntime.pid -eq $prototypeProcess.Id) {
            Write-Output ('ChatGPT login prototype: ' + $newRuntime.url)
            exit 0
        }
    }
}
throw 'The prototype did not report its local URL in time.'
