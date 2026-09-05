$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$env:CARGO_HOME = Join-Path $workspaceRoot 'target/vortex-state-probe/cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $workspaceRoot 'target/vortex-state-probe/build'
cargo build --locked --release --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Standalone probe build failed.' }
