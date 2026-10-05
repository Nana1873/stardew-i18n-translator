param(
    [Parameter(Mandatory = $true)][ValidateSet('release', 'read')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Zip,
    [string]$Destination,
    [string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($Zip)
try {
    $entries = @($archive.Entries)
    $names = @($entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if ($Action -eq 'release') {
        $expected = @('Stardew i18n Translator/README.txt', 'Stardew i18n Translator/stardew-i18n-translator.exe')
        if ($entries.Count -ne 2 -or @(Compare-Object $names $expected -CaseSensitive).Count -ne 0) {
            throw 'Release ZIP must contain exactly the documented README and EXE; data folders and other entries are forbidden.'
        }
        if (!$ExpectedVersion) { throw 'Expected release version is required.' }
        $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
        $runsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'target/desktop-e2e/runs')).TrimEnd('\') + '\'
        $resolved = [IO.Path]::GetFullPath($Destination)
        if (!$resolved.StartsWith($runsRoot, [StringComparison]::OrdinalIgnoreCase) -or !$resolved.EndsWith('\runtime\app', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Release extraction must target a generated test runtime/app directory.'
        }
        # Validate everything before writing, then extract only explicit basenames.
        # Never use an archive member path as a destination.
        foreach ($entry in $entries) {
            $limit = if ($entry.Name -eq 'README.txt') { 1MB } else { 200MB }
            if ($entry.Length -le 0 -or $entry.Length -gt $limit) { throw 'Unexpected release member size.' }
        }
        New-Item -ItemType Directory -Path $resolved -Force | Out-Null
        foreach ($entry in $entries) {
            $name = if ($entry.FullName.Replace('\', '/').EndsWith('/README.txt')) { 'README.txt' } else { 'stardew-i18n-translator.exe' }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $resolved $name), $false)
        }
        $exe = Join-Path $resolved 'stardew-i18n-translator.exe'
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
        if ($version -ne $ExpectedVersion) { throw "Expected archived executable version $ExpectedVersion, got '$version'." }
        @{ entries = $names; productVersion = $version } | ConvertTo-Json -Compress
    } else {
        if ($entries.Count -gt 100) { throw 'Unexpected number of synthetic translation ZIP members.' }
        $files = [ordered]@{}
        foreach ($entry in $entries) {
            if ($entry.Length -gt 1MB) { throw 'Synthetic translation ZIP member is unexpectedly large.' }
            $name = $entry.FullName.Replace('\', '/')
            if ($files.Contains($name)) { throw 'Duplicate translation ZIP member.' }
            $reader = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
            try { $files[$name] = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        $files | ConvertTo-Json -Compress
    }
} finally { $archive.Dispose() }
