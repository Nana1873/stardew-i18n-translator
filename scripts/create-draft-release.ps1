param(
    [Parameter(Mandatory = $true)]
    [string]$ZipPath
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content (Join-Path $repoRoot "package.json") | ConvertFrom-Json
$version = $packageJson.version
$tag = "v$version"
$expectedName = "Stardew-i18n-Translator_${version}_windows-x64-portable.zip"
$resolvedZip = (Resolve-Path -LiteralPath $ZipPath).Path

if ([System.IO.Path]::GetFileName($resolvedZip) -ne $expectedName) {
    throw "Expected release archive named $expectedName, got $resolvedZip"
}

Push-Location $repoRoot
try {
    if (git status --porcelain) {
        throw "Release drafts must be created from a clean working tree."
    }

    git fetch origin main --tags
    $headCommit = (git rev-parse HEAD).Trim()
    $mainCommit = (git rev-parse origin/main).Trim()
    if ($headCommit -ne $mainCommit) {
        throw "HEAD must equal current origin/main. HEAD: $headCommit; origin/main: $mainCommit"
    }

    corepack pnpm check:docs
    if ($LASTEXITCODE -ne 0) {
        throw "Documentation and version checks failed."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedZip)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace("/", "\") })
        $expectedEntries = @(
            "Stardew i18n Translator\README.txt",
            "Stardew i18n Translator\stardew-i18n-translator.exe"
        )
        $actualLayout = ($entries | Sort-Object) -join "`n"
        $expectedLayout = ($expectedEntries | Sort-Object) -join "`n"
        if ($actualLayout -ne $expectedLayout) {
            throw "Portable archive must contain exactly README.txt and stardew-i18n-translator.exe."
        }
    }
    finally {
        $archive.Dispose()
    }

    $existingTag = git tag --list $tag
    if ($existingTag) {
        $tagCommit = (git rev-list -n 1 $tag).Trim()
        if ($tagCommit -ne $headCommit) {
            throw "Existing tag $tag points to $tagCommit instead of $headCommit."
        }
    }
    else {
        git tag -a $tag -m "Stardew i18n Translator $tag"
    }

    $remoteTag = git ls-remote --tags origin "refs/tags/$tag"
    if (-not $remoteTag) {
        git push origin $tag
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to push release tag $tag."
        }
    }

    $releaseJson = gh release list `
        --repo Nana1873/stardew-i18n-translator `
        --limit 100 `
        --json tagName
    if ($LASTEXITCODE -ne 0) {
        throw "Could not check for an existing GitHub release."
    }
    $existingRelease = $releaseJson |
        ConvertFrom-Json |
        Where-Object { $_.tagName -eq $tag }
    if ($existingRelease) {
        throw "A GitHub release already exists for $tag."
    }

    $generatedNotes = gh api `
        --method POST `
        "repos/Nana1873/stardew-i18n-translator/releases/generate-notes" `
        -f tag_name=$tag `
        -f target_commitish=$headCommit `
        --jq .body
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to generate GitHub release notes."
    }

    $notesPath = Join-Path ([System.IO.Path]::GetTempPath()) "stardew-release-$version-notes.md"
    $curatedNotes = Join-Path $repoRoot "docs\release\v$version.md"
    if (Test-Path -LiteralPath $curatedNotes -PathType Leaf) {
        Get-Content -Raw $curatedNotes | Set-Content -Encoding utf8 $notesPath
        "`n---`n`n## Merged pull requests`n" | Add-Content -Encoding utf8 $notesPath
    }
    else {
        Set-Content -Encoding utf8 $notesPath -Value ""
    }
    $generatedNotes | Add-Content -Encoding utf8 $notesPath

    gh release create $tag $resolvedZip `
        --repo Nana1873/stardew-i18n-translator `
        --draft `
        --title "Stardew i18n Translator $tag" `
        --notes-file $notesPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create draft release for $tag."
    }

    $hash = (Get-FileHash -LiteralPath $resolvedZip -Algorithm SHA256).Hash
    Write-Output "Draft release created for $tag from commit $headCommit."
    Write-Output "Portable ZIP SHA-256: $hash"
}
finally {
    Pop-Location
}
