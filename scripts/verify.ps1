<#
.SYNOPSIS
    Runs local verification checks for the Stardew i18n Translator project.
.DESCRIPTION
    Runs all local code quality, style, formatting, and unit tests for both
    the React frontend and the Rust backend, matching the requirements of the SKILL.md.
.PARAMETER FrontendOnly
    Only run frontend checks (tsc, vitest, check:docs).
.PARAMETER BackendOnly
    Only run backend checks (cargo fmt, cargo clippy, cargo test).
.PARAMETER Quick
    Skip clippy and tsc, run only tests.
#>
param(
    [switch]$FrontendOnly,
    [switch]$BackendOnly,
    [switch]$Quick
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

$failed = $false
$results = [ordered]@{}

function Run-Step([string]$name, [scriptblock]$script) {
    Write-Host "`n=== Running Step: $name ===" -ForegroundColor Cyan
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    
    # Reset exit code
    $global:LASTEXITCODE = 0
    
    try {
        & $script
        $exitCode = $global:LASTEXITCODE
        $stopwatch.Stop()
        if ($exitCode -eq 0) {
            Write-Host "Success: ${name} ($($stopwatch.Elapsed.TotalSeconds.ToString("F2"))s)" -ForegroundColor Green
            $results[${name}] = "PASSED ($($stopwatch.Elapsed.TotalSeconds.ToString("F2"))s)"
        } else {
            Write-Host "Failed: ${name} with exit code $exitCode ($($stopwatch.Elapsed.TotalSeconds.ToString("F2"))s)" -ForegroundColor Red
            $results[${name}] = "FAILED"
            $script:failed = $true
        }
    } catch {
        $stopwatch.Stop()
        Write-Host "Error running ${name}: $_" -ForegroundColor Red
        $results[${name}] = "ERROR"
        $script:failed = $true
    }
}

$runFrontend = -not $BackendOnly
$runBackend = -not $FrontendOnly

# Frontend Checks
if ($runFrontend) {
    if (-not $Quick) {
        Run-Step "TypeScript compilation check (tsc)" {
            corepack pnpm exec tsc --noEmit
        }
    }
    
    Run-Step "Frontend tests (vitest)" {
        corepack pnpm test
    }
    
    Run-Step "Documentation and Prettier formatting checks" {
        corepack pnpm check:docs
    }
}

# Backend Checks
if ($runBackend) {
    Push-Location src-tauri
    try {
        Run-Step "Rust formatting check (cargo fmt)" {
            cargo fmt --check
        }
        
        if (-not $Quick) {
            Run-Step "Rust linter (cargo clippy)" {
                cargo clippy --locked --all-targets --profile ci -- -D warnings
            }
        }
        
        Run-Step "Rust unit/integration tests (cargo test)" {
            cargo test --locked --profile ci
        }
    } finally {
        Pop-Location
    }
}

Pop-Location

# Summary report
Write-Host "`n========================================" -ForegroundColor Yellow
Write-Host "         VERIFICATION SUMMARY" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
foreach ($key in $results.Keys) {
    $status = $results[$key]
    if ($status -like "PASSED*") {
        Write-Host "  [OK]   $key : $status" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] $key : $status" -ForegroundColor Red
    }
}
Write-Host "========================================" -ForegroundColor Yellow

if ($failed) {
    Write-Host "Verification failed!" -ForegroundColor Red
    exit 1
} else {
    Write-Host "Verification passed!" -ForegroundColor Green
    exit 0
}
