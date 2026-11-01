import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { blenderDistribution, bundledBlenderPath } from '../src/main/native-runtime'

const root = resolve('.tools')
const distribution = blenderDistribution()
const executable = bundledBlenderPath(resolve('.'))
const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: 'inherit' })
const check = () => run(executable, ['--background', '--factory-startup', '--version'])

if (existsSync(executable)) {
  check()
} else {
  await mkdir(root, { recursive: true })
  const staging = await mkdtemp(join(root, 'blender-install-'))
  const archive = join(staging, distribution.archive)
  const destination = join(root, distribution.directory)
  try {
    console.log(`Downloading official native Blender ${distribution.directory} (isolated from ComfyUI)...`)
    run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '-fL', '--retry', '2', '--output', archive,
      `https://mirror.blender.org/release/Blender4.5/${distribution.archive}`
    ])
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    if (hash.digest('hex') !== distribution.sha256)
      throw new Error('Blender archive checksum does not match the official release. Archive will not be executed.')

    if (process.platform === 'win32') {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
      run('powershell.exe', ['-NoProfile', '-Command',
        `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)}`])
    } else if (process.platform === 'linux') {
      run('tar', ['-xJf', archive, '-C', staging])
    } else {
      const mount = join(staging, 'mount')
      await mkdir(mount)
      run('hdiutil', ['attach', archive, '-nobrowse', '-readonly', '-mountpoint', mount])
      try {
        await mkdir(join(staging, distribution.directory))
        run('ditto', [join(mount, 'Blender.app'), join(staging, distribution.directory, 'Blender.app')])
      } finally {
        run('hdiutil', ['detach', mount])
      }
    }
    await rename(join(staging, distribution.directory), destination)
    check()
    console.log(`Ready: ${executable}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
