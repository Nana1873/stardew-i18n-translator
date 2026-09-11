param([Parameter(Mandatory = $true)][string]$Runtime)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target/desktop-e2e/runs')).TrimEnd('\') + '\'
$resolved = [IO.Path]::GetFullPath($Runtime)
if (!$resolved.StartsWith($runsRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -ne 'runtime') {
    throw 'Archive probes require a generated test runtime.'
}
$cases = @(
    @{ name = 'extra-data'; entries = @('Stardew i18n Translator/README.txt', 'Stardew i18n Translator/stardew-i18n-translator.exe', 'Stardew i18n Translator/data/settings.json'); error = 'exactly' },
    @{ name = 'traversal'; entries = @('../escaped.txt', 'Stardew i18n Translator/stardew-i18n-translator.exe'); error = 'exactly' },
    @{ name = 'duplicate'; entries = @('Stardew i18n Translator/README.txt', 'Stardew i18n Translator/README.txt'); error = 'exactly' },
    @{ name = 'missing-version'; entries = @('Stardew i18n Translator/README.txt', 'Stardew i18n Translator/stardew-i18n-translator.exe'); error = 'archived executable version' }
)
foreach ($case in $cases) {
    $root = Join-Path $resolved ('archive-probes/' + $case.name)
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $zip = Join-Path $root 'invalid.zip'
    $archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $case.entries) {
            $writer = New-Object IO.StreamWriter($archive.CreateEntry($name).Open())
            try { $writer.Write('Synthetic invalid archive; never executable.') } finally { $writer.Dispose() }
        }
    } finally { $archive.Dispose() }
    $destination = Join-Path $root 'runtime/app'
    $rejected = $false
    try { & (Join-Path $PSScriptRoot 'archive.ps1') -Action release -Zip $zip -Destination $destination -ExpectedVersion '0.0.0' | Out-Null }
    catch {
        if ($_.Exception.Message -notmatch $case.error) { throw }
        $rejected = $true
    }
    if (!$rejected) { throw "Invalid archive was accepted: $($case.name)" }
    if ($case.name -ne 'missing-version' -and (Test-Path -LiteralPath $destination)) {
        throw 'Layout rejection must happen before extraction.'
    }
    if (Test-Path -LiteralPath (Join-Path $root 'runtime/escaped.txt')) { throw 'Archive traversal escaped the destination.' }
    Write-Output "PASS archive rejects $($case.name)"
}
# An otherwise valid layout must not be extracted outside the runtime/app scope.
$outside = Join-Path $resolved 'forbidden-destination'
$rejected = $false
try { & (Join-Path $PSScriptRoot 'archive.ps1') -Action release -Zip $zip -Destination $outside -ExpectedVersion '0.0.0' | Out-Null }
catch {
    if ($_.Exception.Message -notmatch 'generated test runtime/app') { throw }
    $rejected = $true
}
if (!$rejected -or (Test-Path -LiteralPath $outside)) { throw 'Archive extraction did not enforce its destination boundary.' }
Write-Output 'PASS archive rejects extraction outside runtime/app'

# Multiple installation roots must not broaden native process ownership.
foreach ($probe in @(
    @{ executable = (Get-Process -Id $PID).Path; expected = 'supervisor-owned runtime' },
    @{ executable = (Join-Path $resolved 'app/stardew-i18n-translator.exe'); expected = 'outside this test application' }
)) {
    $rejected = $false
    try { & (Join-Path $PSScriptRoot 'native.ps1') -AppProcessId $PID -Executable $probe.executable -Action metrics | Out-Null }
    catch {
        if ($_.Exception.Message -notmatch $probe.expected) { throw }
        $rejected = $true
    }
    if (!$rejected) { throw 'Native helper accepted an unrelated process.' }
    Write-Output "PASS native rejects $($probe.expected)"
}
