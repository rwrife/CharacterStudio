$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  & node --import tsx scripts\setup-blender.ts
  if ($LASTEXITCODE -ne 0) { throw 'Blender setup failed. Retry npm run setup:blender.' }
} finally {
  Pop-Location
}
