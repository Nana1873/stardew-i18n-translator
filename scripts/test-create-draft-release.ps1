$ErrorActionPreference = "Stop"

$releaseScript = Join-Path $PSScriptRoot "create-draft-release.ps1"
$repoRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$tag = "v$version"
$headCommit = "0123456789abcdef0123456789abcdef01234567"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "stardew-release-tests-$PID"
$archiveRoot = Join-Path $tempRoot "archive"
$archiveFolder = Join-Path $archiveRoot "Stardew i18n Translator"
$zipPath = Join-Path $tempRoot "Stardew-i18n-Translator_${version}_windows-x64-portable.zip"

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Reset-Scenario {
    param(
        [bool]$LocalTag = $false,
        [bool]$RemoteTag = $false,
        [bool]$ReleaseExists = $false,
        [bool]$TagPushFails = $false,
        [bool]$ReleaseCreationFails = $false
    )

    $global:ReleaseTestState = @{
        Events = [System.Collections.Generic.List[string]]::new()
        LocalTag = $LocalTag
        RemoteTag = $RemoteTag
        ReleaseExists = $ReleaseExists
        TagPushFails = $TagPushFails
        ReleaseCreationFails = $ReleaseCreationFails
    }
}

function global:git {
    $arguments = @($args)
    $command = $arguments -join " "
    $global:LASTEXITCODE = 0

    switch -Regex ($command) {
        "^status --porcelain$" {
            return
        }
        "^fetch origin main --tags$" {
            [void]$global:ReleaseTestState.Events.Add("fetch")
            return
        }
        "^rev-parse HEAD$" {
            return $headCommit
        }
        "^rev-parse origin/main$" {
            return $headCommit
        }
        "^tag --list $([regex]::Escape($tag))$" {
            if ($global:ReleaseTestState.LocalTag) {
                return $tag
            }
            return
        }
        "^rev-list -n 1 $([regex]::Escape($tag))$" {
            return $headCommit
        }
        "^ls-remote --tags origin " {
            if ($global:ReleaseTestState.RemoteTag) {
                return "$headCommit`trefs/tags/$tag^{}"
            }
            return
        }
        "^tag -a $([regex]::Escape($tag)) " {
            [void]$global:ReleaseTestState.Events.Add("create-local-tag")
            $global:ReleaseTestState.LocalTag = $true
            return
        }
        "^push origin $([regex]::Escape($tag))$" {
            [void]$global:ReleaseTestState.Events.Add("push-remote-tag")
            if ($global:ReleaseTestState.TagPushFails) {
                $global:LASTEXITCODE = 1
                return
            }
            $global:ReleaseTestState.RemoteTag = $true
            return
        }
        "^push origin :refs/tags/$([regex]::Escape($tag))$" {
            [void]$global:ReleaseTestState.Events.Add("delete-remote-tag")
            $global:ReleaseTestState.RemoteTag = $false
            return
        }
        "^tag -d $([regex]::Escape($tag))$" {
            [void]$global:ReleaseTestState.Events.Add("delete-local-tag")
            $global:ReleaseTestState.LocalTag = $false
            return
        }
        default {
            throw "Unexpected git invocation: $command"
        }
    }
}

function global:corepack {
    $command = @($args) -join " "
    if ($command -ne "pnpm check:docs") {
        throw "Unexpected corepack invocation: $command"
    }
    [void]$global:ReleaseTestState.Events.Add("check-docs")
    $global:LASTEXITCODE = 0
}

function global:gh {
    $arguments = @($args)
    $command = $arguments -join " "
    $global:LASTEXITCODE = 0

    if ($command -match "^release list ") {
        [void]$global:ReleaseTestState.Events.Add("check-release")
        if ($global:ReleaseTestState.ReleaseExists) {
            return "[{`"tagName`":`"$tag`"}]"
        }
        return "[]"
    }

    if ($command -match "^api ") {
        [void]$global:ReleaseTestState.Events.Add("generate-notes")
        return "Generated release notes"
    }

    if ($command -match "^release create ") {
        [void]$global:ReleaseTestState.Events.Add("create-release")
        if ($global:ReleaseTestState.ReleaseCreationFails) {
            $global:LASTEXITCODE = 1
            return
        }
        return "https://example.invalid/release"
    }

    throw "Unexpected gh invocation: $command"
}

try {
    New-Item -ItemType Directory -Path $archiveFolder -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $archiveFolder "README.txt") -Value "test"
    Set-Content -LiteralPath (Join-Path $archiveFolder "stardew-i18n-translator.exe") -Value "test"
    Compress-Archive -Path $archiveFolder -DestinationPath $zipPath

    Reset-Scenario
    $preflightOutput = & $releaseScript -ZipPath $zipPath -Preflight
    Assert-True (@($preflightOutput -match "Preflight passed").Count -gt 0) "Preflight did not report success."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "create-local-tag")) "Preflight created a local tag."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "push-remote-tag")) "Preflight pushed a remote tag."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "create-release")) "Preflight created a release."

    Reset-Scenario -ReleaseCreationFails $true
    $failed = $false
    try {
        & $releaseScript -ZipPath $zipPath | Out-Null
    }
    catch {
        $failed = $true
        Assert-True ($_.Exception.Message -match "rolled back") "Failure did not report rollback."
    }
    Assert-True $failed "Release creation failure did not fail the script."
    $expectedRollback = @(
        "fetch",
        "check-docs",
        "check-release",
        "generate-notes",
        "create-local-tag",
        "push-remote-tag",
        "create-release",
        "delete-remote-tag",
        "delete-local-tag"
    )
    Assert-True (
        ($global:ReleaseTestState.Events -join "`n") -eq ($expectedRollback -join "`n")
    ) "New tags were not rolled back in the expected order."

    Reset-Scenario -TagPushFails $true
    $pushFailed = $false
    try {
        & $releaseScript -ZipPath $zipPath | Out-Null
    }
    catch {
        $pushFailed = $true
        Assert-True ($_.Exception.Message -match "rolled back") "Tag push failure did not report rollback."
    }
    Assert-True $pushFailed "Tag push failure did not fail the script."
    Assert-True ($global:ReleaseTestState.Events -contains "delete-local-tag") "Tag push failure left the new local tag behind."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "delete-remote-tag")) "Tag push failure tried to delete a remote tag that was not pushed."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "create-release")) "Release creation ran after the tag push failed."

    Reset-Scenario -LocalTag $true -RemoteTag $true -ReleaseCreationFails $true
    $preExistingTagFailure = $false
    try {
        & $releaseScript -ZipPath $zipPath | Out-Null
    }
    catch {
        $preExistingTagFailure = $true
        Assert-True ($_.Exception.Message -match "No pre-existing tags were changed") "Failure did not report transaction handling."
    }
    Assert-True $preExistingTagFailure "Release failure with pre-existing tags did not fail the script."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "delete-remote-tag")) "A pre-existing remote tag was deleted."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "delete-local-tag")) "A pre-existing local tag was deleted."

    Reset-Scenario
    $successOutput = & $releaseScript -ZipPath $zipPath
    Assert-True (@($successOutput -match "Draft release created").Count -gt 0) "Successful release did not report completion."
    Assert-True ($global:ReleaseTestState.RemoteTag) "Successful release did not leave the remote tag in place."
    Assert-True ($global:ReleaseTestState.LocalTag) "Successful release did not leave the local tag in place."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "delete-remote-tag")) "Successful release rolled back its tag."

    Reset-Scenario -ReleaseExists $true
    $existingReleaseFailed = $false
    try {
        & $releaseScript -ZipPath $zipPath | Out-Null
    }
    catch {
        $existingReleaseFailed = $true
    }
    Assert-True $existingReleaseFailed "An existing release did not stop the script."
    Assert-True (-not ($global:ReleaseTestState.Events -contains "create-local-tag")) "Existing release check happened after tag creation."

    Write-Output "Release script transaction tests passed."
}
finally {
    Remove-Item Function:\git -ErrorAction SilentlyContinue
    Remove-Item Function:\gh -ErrorAction SilentlyContinue
    Remove-Item Function:\corepack -ErrorAction SilentlyContinue
    Remove-Variable ReleaseTestState -Scope Global -ErrorAction SilentlyContinue

    $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
    $systemTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTempRoot.StartsWith($systemTempRoot) -and (Test-Path -LiteralPath $resolvedTempRoot)) {
        Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
    }
}
