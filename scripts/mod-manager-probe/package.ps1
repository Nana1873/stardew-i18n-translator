$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$probeRoot = Join-Path $workspaceRoot 'target/mod-manager-probe'
$env:UV_CACHE_DIR = Join-Path $probeRoot 'uv-cache'
$env:PYINSTALLER_CONFIG_DIR = Join-Path $probeRoot 'pyinstaller-cache'
$env:TEMP = Join-Path $probeRoot 'build-temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
Push-Location $workspaceRoot
try {
    uv pip install --python ./target/mod-manager-probe/.venv/Scripts/python.exe 'pyinstaller==6.22.2' 'pyinstaller-hooks-contrib==2026.7' 'altgraph==0.17.5' 'pefile==2024.8.26' 'pywin32-ctypes==0.2.3' 'setuptools==84.0.0'
    if ($LASTEXITCODE -ne 0) { throw 'Packaging dependency installation failed.' }
    & ./target/mod-manager-probe/.venv/Scripts/python.exe -m PyInstaller --noconfirm --onedir --console --name mod-manager-probe --distpath ./target/mod-manager-probe/packaged --workpath ./target/mod-manager-probe/package-work --specpath ./target/mod-manager-probe --hidden-import plyvel_next scripts/mod-manager-probe/probe.py
    if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
} finally { Pop-Location }
