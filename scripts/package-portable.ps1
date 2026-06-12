param(
    [string]$Configuration = "release"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$targetDir = Join-Path $repoRoot "src-tauri\target\$Configuration"
$executable = Join-Path $targetDir "stardew-i18n-translator.exe"

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Portable executable not found: $executable"
}

$outputDir = Join-Path $targetDir "portable"
$packageName = "Stardew-i18n-Translator_${version}_windows-x64-portable"
$stagingDir = Join-Path $outputDir "Stardew i18n Translator"
$zipPath = Join-Path $outputDir "$packageName.zip"

$resolvedOutput = [System.IO.Path]::GetFullPath($outputDir)
$resolvedStaging = [System.IO.Path]::GetFullPath($stagingDir)
if (-not $resolvedStaging.StartsWith($resolvedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to prepare a portable package outside $resolvedOutput"
}

if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path (Join-Path $stagingDir "Data") -Force | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $stagingDir "stardew-i18n-translator.exe")
Copy-Item -LiteralPath (Join-Path $repoRoot "distribution\Data\README.txt") -Destination (Join-Path $stagingDir "Data\README.txt")

Compress-Archive -LiteralPath $stagingDir -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output $zipPath
