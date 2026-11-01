$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$exe = Join-Path $PSScriptRoot 'release\CharacterStudio-win32-arm64\CharacterStudio.exe'
if (Test-Path $exe) { Start-Process -FilePath $exe; exit }
if (-not (Test-Path 'node_modules\electron')) { throw 'Run npm install, npm run setup:blender, and npm run build first.' }
npm start
