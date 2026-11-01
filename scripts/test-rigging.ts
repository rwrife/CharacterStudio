import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundledBlenderPath } from '../src/main/native-runtime'
import { validateCharacterGlb } from '../src/main/export-validation'

const output = await mkdtemp(join(tmpdir(), 'studio-native-skin-'))
try {
  execFileSync(bundledBlenderPath(resolve('.')), [
    '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
    '--python', resolve('tests', 'test_rigging_blender.py')
  ], { stdio: 'inherit', env: { ...process.env, STUDIO_RIG_TEST_OUTPUT: output } })
  await validateCharacterGlb(join(output, 'rigged.glb'), false)
  console.log('Fallback GLB passed the desktop character-export validator.')
} finally {
  await rm(output, { recursive: true, force: true })
}
