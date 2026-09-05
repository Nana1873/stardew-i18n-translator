$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$probeRoot = Join-Path $workspaceRoot 'target/mod-manager-probe'
New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
$env:UV_CACHE_DIR = Join-Path $probeRoot 'uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $probeRoot 'python'
$env:UV_PYTHON_CACHE_DIR = Join-Path $probeRoot 'python-cache'
$dependencies = @{
    'mod-manager-lib' = 'a40880d22e0658f717d301a0a5047ed6a6cffbe8'
    'cutleast-core-lib' = 'e56ec58eee246a8e5a9c20140bcc07003d4d7ad6'
}
foreach ($name in $dependencies.Keys) {
    $commit = $dependencies[$name]
    $destination = Join-Path $probeRoot "$name-$commit"
    if (-not (Test-Path -LiteralPath $destination)) {
        $archive = Join-Path $probeRoot "$name.zip"
        Invoke-WebRequest "https://codeload.github.com/Cutleast/$name/zip/$commit" -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $probeRoot
    }
}
uv python install --no-bin --no-registry 3.14.2
if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
if (-not (Test-Path (Join-Path $probeRoot '.venv/Scripts/python.exe'))) {
    uv venv --python 3.14.2 (Join-Path $probeRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed.' }
}
$python = Join-Path $probeRoot '.venv/Scripts/python.exe'
$library = Join-Path $probeRoot "mod-manager-lib-$($dependencies['mod-manager-lib'])"
$core = Join-Path $probeRoot "cutleast-core-lib-$($dependencies['cutleast-core-lib'])"
# Use the pinned upstream lock as constraints, without installing its dev group.
& $python -c 'import pathlib,sys,tomllib; lock=tomllib.loads(pathlib.Path(sys.argv[1]).read_text()); pathlib.Path(sys.argv[2]).write_text("\n".join(p["name"]+"=="+p["version"] for p in lock["package"] if "registry" in p.get("source",{}))+"\n")' (Join-Path $library 'uv.lock') (Join-Path $probeRoot 'constraints.txt')
Push-Location $workspaceRoot
try {
    uv pip install --no-sources --python ./target/mod-manager-probe/.venv/Scripts/python.exe --constraint ./target/mod-manager-probe/constraints.txt "./target/mod-manager-probe/cutleast-core-lib-$($dependencies['cutleast-core-lib'])" "./target/mod-manager-probe/mod-manager-lib-$($dependencies['mod-manager-lib'])"
} finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Probe dependency installation failed.' }
uv pip freeze --python $python | Set-Content (Join-Path $probeRoot 'installed.txt')
Write-Output "Probe Python: $python"
