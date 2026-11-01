$ErrorActionPreference = 'Stop'
$version = '4.5.15'
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$hashes = @{
  arm64 = 'a095662a0c0063ccfb3d50760462d4a3cc74e6ee20880e85f639c28bc323db93'
  x64 = '52dd02fd74877fa08e74b67d7854cf32468a232c02aaa19b6844c91285574f8d'
}
$root = Join-Path (Split-Path $PSScriptRoot -Parent) '.tools'
$name = "blender-$version-windows-$arch"
$exe = Join-Path $root "$name\blender.exe"
if (Test-Path $exe) { & $exe --background --factory-startup --version; exit $LASTEXITCODE }
New-Item -ItemType Directory -Path $root -Force | Out-Null
$zip = Join-Path $root "$name.zip"
Write-Host "Downloading official native $arch Blender $version (isolated from ComfyUI)..."
& curl.exe -fL --retry 2 --output $zip "https://mirror.blender.org/release/Blender4.5/$name.zip"
if ($LASTEXITCODE -ne 0) { throw 'Blender download failed. Retry npm run setup:blender.' }
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$arch]) {
  throw 'Blender archive checksum does not match the official release. Archive will not be executed.'
}
Expand-Archive -LiteralPath $zip -DestinationPath $root -Force
Remove-Item -LiteralPath $zip
& $exe --background --factory-startup --version
if ($LASTEXITCODE -ne 0) { throw 'Blender failed its native launch check.' }
Write-Host "Ready: $exe"
