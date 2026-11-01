import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { blenderDistribution, bundledBlenderPath, comfyPythonPath, defaultComfyRoot } from '../src/main/native-runtime'
import { ignorePackagePath } from '../scripts/package'

test('every release target selects its matching archive, checksum and executable', () => {
  const targets = [
    ['win32', 'x64', 'windows-x64.zip', ['blender.exe']],
    ['win32', 'arm64', 'windows-arm64.zip', ['blender.exe']],
    ['linux', 'x64', 'linux-x64.tar.xz', ['blender']],
    ['darwin', 'x64', 'macos-x64.dmg', ['Blender.app', 'Contents', 'MacOS', 'Blender']],
    ['darwin', 'arm64', 'macos-arm64.dmg', ['Blender.app', 'Contents', 'MacOS', 'Blender']]
  ] as const
  const hashes = new Set<string>()
  for (const [platform, arch, suffix, executable] of targets) {
    const distribution = blenderDistribution(platform, arch)
    assert.equal(distribution.archive, `blender-4.5.15-${suffix}`)
    assert.match(distribution.sha256, /^[a-f0-9]{64}$/)
    hashes.add(distribution.sha256)
    assert.equal(bundledBlenderPath('app', platform, arch), join('app', '.tools', distribution.directory, ...executable))
  }
  assert.equal(hashes.size, targets.length)
  for (const [platform, arch] of [['linux', 'arm64'], ['win32', 'ia32'], ['freebsd', 'x64']])
    assert.throws(() => blenderDistribution(platform, arch), /Unsupported Blender target/)
})

test('ComfyUI defaults and all Python callers use native paths', () => {
  assert.equal(defaultComfyRoot('win32', { LOCALAPPDATA: 'local' }, 'home'), join('local', 'ComfyUI'))
  assert.equal(defaultComfyRoot('linux', { LOCALAPPDATA: 'local' }, 'home'), join('home', 'ComfyUI'))
  assert.equal(defaultComfyRoot('darwin', {}, 'home'), join('home', 'ComfyUI'))
  assert.equal(comfyPythonPath('comfy', 'win32'), join('comfy', 'venv', 'Scripts', 'python.exe'))
  for (const platform of ['linux', 'darwin'])
    assert.equal(comfyPythonPath('comfy', platform), join('comfy', 'venv', 'bin', 'python'))
})

test('packages include only app files and the target runtime, retaining its licenses', () => {
  const runtime = blenderDistribution('win32', 'arm64').directory
  for (const path of ['', '/out/main/index.js', '/backend/character.py', '/package.json', '/node_modules/react/index.js',
    '/scripts', '/scripts/mcp-client.mjs', '/.tools', `/.tools/${runtime}`, `/.tools/${runtime}/blender.exe`, `/.tools/${runtime}/license/GPL-3.0.txt`])
    assert.equal(ignorePackagePath(path, runtime), false, path)
  for (const path of ['/src/main/index.ts', '/tests/fixture.fbx', '/artifacts/private.fbx', '/scripts/setup-blender.ts',
    '/.github/workflows/release.yml', '/release/app.exe', '/.git/config', '/.env', '/.env.local', '/backend/.env',
    '/backend/__pycache__/character.pyc', '/backend/private.log', '/node_modules/.cache/data', '/node_modules/.bin/tsx',
    '/backend/mcp-connection.json', '/backend/mcp-settings.json', '/node_modules/.mcp-a123.tmp',
    '/.tools/blender-install-temp', `/.tools/${runtime}.zip`, '/.tools/blender-4.5.15-windows-x64/blender.exe'])
    assert.equal(ignorePackagePath(path, runtime), true, path)
  assert.equal(ignorePackagePath(`\\.tools\\${runtime}\\blender.exe`, runtime), false)
})
