$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$toolsRoot = Join-Path $repoRoot 'target/desktop-e2e/tools'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
$runtimeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft/EdgeWebView/Application'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft/EdgeWebView/Application')
)
$runtime = $runtimeCandidates | Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -Directory } |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'msedgewebview2.exe')) } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if ($null -eq $runtime) { throw 'Install the x64 Microsoft Edge WebView2 Evergreen Runtime first.' }
$version = $runtime.Name
$driverRoot = Join-Path $toolsRoot $version
$driver = Join-Path $driverRoot 'msedgedriver.exe'
if (!(Test-Path -LiteralPath $driver)) {
    New-Item -ItemType Directory -Force -Path $driverRoot | Out-Null
    $zip = Join-Path $driverRoot 'edgedriver_win64.zip'
    Write-Host "Downloading Microsoft Edge WebDriver $version for the installed WebView2 runtime."
    Invoke-WebRequest -UseBasicParsing -Uri "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip" -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $driverRoot -Force
    Remove-Item -LiteralPath $zip
}
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$signature = Get-AuthenticodeSignature -LiteralPath $driver
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Microsoft Edge WebDriver signature verification failed.' }
$driverVersion = & $driver --version
if ($LASTEXITCODE -ne 0 -or $driverVersion -notlike "Microsoft Edge WebDriver $version *") { throw 'Edge WebDriver version verification failed.' }
& cargo install tauri-driver --locked --version 2.0.5
if ($LASTEXITCODE -ne 0) { throw 'Installing tauri-driver failed.' }
$tauriDriver = (Get-Command tauri-driver.exe -ErrorAction Stop).Source
@{ version = $version; runtime = $runtime.FullName; edgeDriver = $driver; tauriDriver = $tauriDriver; tauriDriverVersion = '2.0.5' } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $toolsRoot 'installed.json') -Encoding UTF8
Write-Host "Desktop test tools ready. Run: corepack pnpm test:desktop"
