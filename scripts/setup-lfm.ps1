param([string]$ComfyRoot = "$env:LOCALAPPDATA\ComfyUI")
$ErrorActionPreference = 'Stop'
$python = Join-Path $ComfyRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'The selected ComfyUI Python environment is missing. Set -ComfyRoot to the existing backend folder.'
}
Write-Host 'LFM uses the LFM Open License v1.0 (commercial revenue limitation); the bridge is Apache-2.0.'
Write-Host 'Downloading about 0.8 GB of public, pinned assets. No Llama approval or login is required.'
& $python (Join-Path $PSScriptRoot '..\backend\setup_lfm.py') --comfy $ComfyRoot
if ($LASTEXITCODE -ne 0) { throw 'LFM setup failed. See the error above; no Python packages were replaced.' }
