param(
    [Parameter(Mandatory = $true)]
    [string]$ZipPath,

    [switch]$Preflight
)

$ErrorActionPreference = "Stop"

$repository = "Nana1873/stardew-i18n-translator"
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content (Join-Path $repoRoot "package.json") | ConvertFrom-Json
$version = $packageJson.version
$tag = "v$version"
$expectedName = "Stardew-i18n-Translator_${version}_windows-x64-portable.zip"
$resolvedZip = (Resolve-Path -LiteralPath $ZipPath).Path
$notesPath = $null

if ([System.IO.Path]::GetFileName($resolvedZip) -ne $expectedName) {
    throw "Expected release archive named $expectedName, got $resolvedZip"
}

Push-Location $repoRoot
try {
    if (git status --porcelain) {
        throw "Release drafts must be created from a clean working tree."
    }

    git fetch origin main --tags
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to fetch current main and tags."
    }

    $headCommit = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Could not resolve HEAD."
    }

    $mainCommit = (git rev-parse origin/main).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Could not resolve origin/main."
    }

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
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect local tag $tag."
    }

    if ($existingTag) {
        $tagCommit = (git rev-list -n 1 $tag).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "Could not resolve local tag $tag."
        }

        if ($tagCommit -ne $headCommit) {
            throw "Existing tag $tag points to $tagCommit instead of $headCommit."
        }
    }

    $remoteTagLines = @(
        git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}"
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect remote tag $tag."
    }

    $remoteTagCommit = $null
    $remoteTagObject = $null
    foreach ($line in $remoteTagLines) {
        if (-not $line) {
            continue
        }

        $parts = $line -split "\s+", 2
        if ($parts.Count -ne 2) {
            throw "Unexpected response while inspecting remote tag $tag."
        }

        if ($parts[1] -eq "refs/tags/$tag^{}") {
            $remoteTagCommit = $parts[0]
        }
        elseif ($parts[1] -eq "refs/tags/$tag") {
            $remoteTagObject = $parts[0]
        }
    }

    if (-not $remoteTagCommit) {
        $remoteTagCommit = $remoteTagObject
    }
    if ($remoteTagCommit -and $remoteTagCommit -ne $headCommit) {
        throw "Remote tag $tag points to $remoteTagCommit instead of $headCommit."
    }

    $releaseJson = gh release list `
        --repo $repository `
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
        "repos/$repository/releases/generate-notes" `
        -f tag_name=$tag `
        -f target_commitish=$headCommit `
        --jq .body
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to generate GitHub release notes."
    }

    $notesPath = Join-Path ([System.IO.Path]::GetTempPath()) "stardew-release-$version-$PID-notes.md"
    $curatedNotes = Join-Path $repoRoot "docs\release\v$version.md"
    if (Test-Path -LiteralPath $curatedNotes -PathType Leaf) {
        Get-Content -Raw $curatedNotes | Set-Content -Encoding utf8 $notesPath
        "`n---`n`n## Merged pull requests`n" | Add-Content -Encoding utf8 $notesPath
    }
    else {
        Set-Content -Encoding utf8 $notesPath -Value ""
    }
    $generatedNotes | Add-Content -Encoding utf8 $notesPath

    $hash = (Get-FileHash -LiteralPath $resolvedZip -Algorithm SHA256).Hash
    if ($Preflight) {
        Write-Output "Preflight passed for $tag at commit $headCommit. No tag or release was created."
        Write-Output "Portable ZIP SHA-256: $hash"
        return
    }

    $createdLocalTag = $false
    $pushedRemoteTag = $false
    try {
        if (-not $existingTag) {
            git tag -a $tag -m "Stardew i18n Translator $tag"
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to create local release tag $tag."
            }
            $createdLocalTag = $true
        }

        if (-not $remoteTagCommit) {
            git push origin $tag
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to push release tag $tag."
            }
            $pushedRemoteTag = $true
        }

        gh release create $tag $resolvedZip `
            --repo $repository `
            --draft `
            --title "Stardew i18n Translator $tag" `
            --notes-file $notesPath
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create draft release for $tag."
        }
    }
    catch {
        $releaseError = $_.Exception.Message
        $rollbackErrors = @()

        if ($pushedRemoteTag) {
            git push origin ":refs/tags/$tag"
            if ($LASTEXITCODE -ne 0) {
                $rollbackErrors += "remote tag $tag could not be removed"
            }
        }

        if ($createdLocalTag) {
            git tag -d $tag
            if ($LASTEXITCODE -ne 0) {
                $rollbackErrors += "local tag $tag could not be removed"
            }
        }

        if ($rollbackErrors.Count -gt 0) {
            throw "$releaseError Rollback incomplete: $($rollbackErrors -join '; ')."
        }
        if ($pushedRemoteTag -or $createdLocalTag) {
            throw "$releaseError Tags created by this run were rolled back."
        }
        throw "$releaseError No pre-existing tags were changed."
    }

    Write-Output "Draft release created for $tag from commit $headCommit."
    Write-Output "Portable ZIP SHA-256: $hash"
}
finally {
    if ($notesPath -and (Test-Path -LiteralPath $notesPath)) {
        Remove-Item -LiteralPath $notesPath -Force
    }
    Pop-Location
}
