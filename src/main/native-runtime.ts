import { join } from 'node:path'
import { homedir } from 'node:os'

export const blenderVersion = '4.5.15'

const distributions = {
  'win32-x64': { platform: 'windows', extension: 'zip', sha256: '52dd02fd74877fa08e74b67d7854cf32468a232c02aaa19b6844c91285574f8d', executable: ['blender.exe'] },
  'win32-arm64': { platform: 'windows', extension: 'zip', sha256: 'a095662a0c0063ccfb3d50760462d4a3cc74e6ee20880e85f639c28bc323db93', executable: ['blender.exe'] },
  'linux-x64': { platform: 'linux', extension: 'tar.xz', sha256: '0d2b8bb2efe97e6c8eb57de6b7322f8800e1984e3125b60decca5f6771e4773e', executable: ['blender'] },
  'darwin-x64': { platform: 'macos', extension: 'dmg', sha256: '3801a97619292a012ede0e855ee705ae872a680474845297b777254f7f21ed78', executable: ['Blender.app', 'Contents', 'MacOS', 'Blender'] },
  'darwin-arm64': { platform: 'macos', extension: 'dmg', sha256: 'bfbc0bda099d1ab7aef0992a584f872f58bed9bb491210ad45f9ca071aa2e688', executable: ['Blender.app', 'Contents', 'MacOS', 'Blender'] }
} as const

export function blenderDistribution(platform: string = process.platform, arch: string = process.arch) {
  const key = `${platform}-${arch}`
  if (!Object.hasOwn(distributions, key)) throw new Error(`Unsupported Blender target: ${key}`)
  const distribution = distributions[key as keyof typeof distributions]
  const directory = `blender-${blenderVersion}-${distribution.platform}-${arch}`
  return { ...distribution, directory, archive: `${directory}.${distribution.extension}` }
}

export function bundledBlenderPath(appRoot: string, platform: string = process.platform, arch: string = process.arch): string {
  const distribution = blenderDistribution(platform, arch)
  return join(appRoot, '.tools', distribution.directory, ...distribution.executable)
}

export function comfyPythonPath(root: string, platform: string = process.platform): string {
  return platform === 'win32' ? join(root, 'venv', 'Scripts', 'python.exe') : join(root, 'venv', 'bin', 'python')
}

export function defaultComfyRoot(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(platform === 'win32' ? env.LOCALAPPDATA ?? '' : home, 'ComfyUI')
}
