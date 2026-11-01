import { packager } from '@electron/packager'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { blenderDistribution, bundledBlenderPath } from '../src/main/native-runtime'

export function ignorePackagePath(path: string, runtimeDirectory: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized) return false
  if (/(^|\/)(\.git|\.env(?:\.[^/]*)?|__pycache__|\.cache|\.bin)(\/|$)/.test(normalized)) return true
  if (/\.(log|pyc|pyo)$/.test(normalized)) return true
  if (normalized === '.tools') return false
  if (normalized.startsWith('.tools/'))
    return normalized !== `.tools/${runtimeDirectory}` && !normalized.startsWith(`.tools/${runtimeDirectory}/`)
  const top = normalized.split('/')[0]
  return !['out', 'backend', 'node_modules', 'package.json', 'README.md'].includes(top)
}

async function main() {
  const options = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const match = /^--(platform|arch|out)=(.+)$/.exec(arg)
    if (!match || options.has(match[1])) throw new Error(`Invalid packaging argument: ${arg}. Use --platform=win32|linux|darwin, --arch=x64|arm64 and optionally --out=<directory>.`)
    options.set(match[1], match[2])
  }
  const platform = options.get('platform') ?? process.platform
  const arch = options.get('arch') ?? process.arch
  const distribution = blenderDistribution(platform, arch)
  if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin') throw new Error(`Unsupported platform: ${platform}`)
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Unsupported architecture: ${arch}`)
  await access(resolve('out', 'main', 'index.js'))
  await access(bundledBlenderPath(resolve('.'), platform, arch))
  const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string }
  const paths = await packager({
    dir: '.', name: 'CharacterStudio', platform, arch, out: options.get('out') ?? 'release', overwrite: true,
    asar: false, prune: true, appVersion: version, appBundleId: 'com.rwrife.characterstudio',
    win32metadata: { ProductName: 'Character Studio' },
    ignore: path => ignorePackagePath(path, distribution.directory)
  })
  if (paths.length !== 1) throw new Error(`Expected one packaged application; got ${paths.length}.`)
  const appRoot = platform === 'darwin'
    ? join(paths[0], 'CharacterStudio.app', 'Contents', 'Resources', 'app')
    : join(paths[0], 'resources', 'app')
  for (const file of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'backend/character.py'])
    await access(join(appRoot, ...file.split('/')))
  await access(bundledBlenderPath(appRoot, platform, arch))
  console.log(`Packaged application with native Blender: ${paths[0]}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
