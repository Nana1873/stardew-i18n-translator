param([switch]$Build, [switch]$BuildOnly)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$prototypeRoot = Join-Path $repoRoot 'target\chatgpt-translator-prototype'
$appRoot = Join-Path $prototypeRoot 'app'
$appExe = Join-Path $appRoot 'stardew-i18n-translator.exe'
$pendingExe = Join-Path $appRoot 'stardew-i18n-translator.next.exe'
$helperRoot = Join-Path $prototypeRoot 'auth'
$serverScript = Join-Path $PSScriptRoot 'chatgpt-login-prototype\server.mjs'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$utf8 = [System.Text.UTF8Encoding]::new($false)

$activeApps = @(Get-CimInstance Win32_Process -Filter "Name = 'stardew-i18n-translator.exe'" | Where-Object { $_.ExecutablePath -eq $appExe })
if ($activeApps.Count -gt 0 -and -not $BuildOnly) {
    Write-Output 'The ChatGPT Translator prototype is already running. Close it before rebuilding.'
    exit 0
}

New-Item -ItemType Directory -Path $appRoot, $helperRoot -Force | Out-Null
if ($Build -or $BuildOnly -or -not (Test-Path -LiteralPath $appExe)) {
    $oldFrontendFlag = $env:VITE_CHATGPT_PROTOTYPE
    Push-Location $repoRoot
    try {
        $env:VITE_CHATGPT_PROTOTYPE = '1'
        & corepack pnpm tauri build --debug --no-bundle --features chatgpt-prototype
        if ($LASTEXITCODE -ne 0) { throw 'The ChatGPT Translator prototype build failed.' }
        Copy-Item -LiteralPath (Join-Path $repoRoot 'src-tauri\target\debug\stardew-i18n-translator.exe') -Destination $pendingExe -Force
    }
    finally {
        $env:VITE_CHATGPT_PROTOTYPE = $oldFrontendFlag
        Pop-Location
    }
}
if ($BuildOnly) {
    Write-Output 'Updated ChatGPT Translator prototype prepared. The launcher applies it on the next start.'
    exit 0
}
if (Test-Path -LiteralPath $pendingExe) {
    if (Test-Path -LiteralPath $appExe) {
        Copy-Item -LiteralPath $appExe -Destination ($appExe + '.previous') -Force
    }
    Copy-Item -LiteralPath $pendingExe -Destination $appExe -Force
    Remove-Item -LiteralPath $pendingExe
}

# Synthetic first-run workspace, separate from any existing portable settings.
$gameRoot = Join-Path $prototypeRoot 'fixture\Stardew Valley'
$modsRoot = Join-Path $gameRoot 'Mods'
$modRoot = Join-Path $modsRoot 'ChatGPT Prototype Sample'
$sourceFile = Join-Path $modRoot 'i18n\default.json'
if (-not (Test-Path -LiteralPath $sourceFile)) {
    New-Item -ItemType Directory -Path (Join-Path $gameRoot 'Content'), (Split-Path $sourceFile -Parent) -Force | Out-Null
    $manifest = [ordered]@{ Name='ChatGPT Prototype Sample'; Author='Stardew i18n Translator'; Version='1.0.0'; UniqueID='Nana1873.ChatGPTPrototype'; Description='Synthetic dialogue for the local ChatGPT Translator prototype.' }
    [System.IO.File]::WriteAllText((Join-Path $modRoot 'manifest.json'), ($manifest | ConvertTo-Json), $utf8)
    $source = [ordered]@{
        'Dialogue.Greeting'='Hello, {{PlayerName}}! The harvest festival starts tomorrow.'
        'Dialogue.Pumpkin'='Bring your best pumpkin! I will save you a place near the fountain.'
        'Dialogue.Weather'='A rainy morning is perfect for a warm cup of tea.'
        'Mail.Invitation'='Dear @, come to the town square tomorrow.#$b#Bring a dish to share!'
        'Shop.Description'='A bright bouquet of seasonal flowers.'
    }
    [System.IO.File]::WriteAllText($sourceFile, ($source | ConvertTo-Json), $utf8)
}
$dataRoot = Join-Path $appRoot 'data'
$settingsFile = Join-Path $dataRoot 'settings.json'
if (-not (Test-Path -LiteralPath $settingsFile)) {
    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
    $settings = [ordered]@{
        stardewPath=$gameRoot; modsPath=$modsRoot; sourceLang='default'; targetLang='de'
        ai=@{defaultEngine='chatgpt'; codexModel=$null; codexReasoning='medium'; codexQualityReview=$true}
    }
    [System.IO.File]::WriteAllText($settingsFile, ($settings | ConvertTo-Json -Depth 5), $utf8)
}

$runtimeFile = Join-Path $helperRoot 'runtime.json'
$helperProcess = $null
if (Test-Path -LiteralPath $runtimeFile) {
    $previous = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    $previousProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$previous.pid)" -ErrorAction SilentlyContinue
    if ($previousProcess -and $previousProcess.ExecutablePath -eq $nodeExe -and $previousProcess.CommandLine.Contains($serverScript) -and $previousProcess.CommandLine.Contains('--translator')) {
        $helperProcess = Get-Process -Id $previous.pid
    }
}
if (-not $helperProcess) {
    $oldRuntimeRoot = $env:CHATGPT_PROTOTYPE_RUNTIME_DIR
    try {
        $env:CHATGPT_PROTOTYPE_RUNTIME_DIR = $helperRoot
        $helperProcess = Start-Process -FilePath $nodeExe -ArgumentList ('"' + $serverScript + '" --translator') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $helperRoot 'stdout.log') -RedirectStandardError (Join-Path $helperRoot 'stderr.log') -PassThru
    }
    finally { $env:CHATGPT_PROTOTYPE_RUNTIME_DIR = $oldRuntimeRoot }
}
$runtime = $null
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if ($helperProcess.HasExited) { throw 'The ChatGPT helper could not start. Check target/chatgpt-translator-prototype/auth/stderr.log.' }
    if (Test-Path -LiteralPath $runtimeFile) {
        $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        if ([int]$runtime.pid -eq $helperProcess.Id -and $runtime.url -match '^http://127\.0\.0\.1:[0-9]+$') { break }
    }
    Start-Sleep -Milliseconds 100
}
if (-not $runtime -or [int]$runtime.pid -ne $helperProcess.Id) { throw 'The ChatGPT helper did not become ready.' }

$oldBridge = $env:CHATGPT_TRANSLATOR_BRIDGE
try {
    $env:CHATGPT_TRANSLATOR_BRIDGE = $runtime.url
    $appProcess = Start-Process -FilePath $appExe -WorkingDirectory $appRoot -PassThru
    Write-Output ('ChatGPT Translator prototype opened: ' + $appExe)
    $appProcess.WaitForExit()
}
finally {
    $env:CHATGPT_TRANSLATOR_BRIDGE = $oldBridge
    # Revoke and clear the helper's in-memory credentials on normal app exit.
    try {
        $page = Invoke-WebRequest -Uri $runtime.url -UseBasicParsing -TimeoutSec 5
        $guard = [regex]::Match($page.Content, 'name="prototype-csrf" content="([^"]+)"').Groups[1].Value
        $stopped = Invoke-RestMethod -Uri ($runtime.url + '/api/stop') -Method Post -Headers @{Origin=$runtime.url; 'X-Prototype-CSRF'=$guard} -ContentType 'application/json' -Body '{}' -TimeoutSec 20
        if (-not $stopped.revoked) { Write-Warning 'Remote sign-out was not confirmed. Disconnect Stardew i18n Translator in ChatGPT settings.' }
    }
    catch { Write-Warning 'ChatGPT helper cleanup was not confirmed. Disconnect Stardew i18n Translator in ChatGPT settings if needed.' }
}
