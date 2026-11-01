/** Real learned Kimodo/LFM clips and skinned exports; optional branch validation is strict. */
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Studio } from '../src/main/studio'
import { validateCharacterGlb } from '../src/main/export-validation'
import { localUrl, setupSchema } from '../src/main/validation'

const comfyUrl = localUrl(process.argv[2] ?? 'http://127.0.0.1:8189')
const asset = resolve('artifacts', 'Bruiser_base.fbx')
await access(asset)
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts', 'lfm-integration-'))
const studio = new Studio(root, resolve('.'))
const settings = studio.snapshot().settings
studio.saveSettings({ ...settings, comfyUrl, textEncoder: 'lfm' })
let previous = ''
studio.onUpdate = snapshot => {
  const latest = snapshot.jobs[0]
  const message = latest ? `${latest.stage}: ${latest.message}` : ''
  if (message !== previous) { console.log(message); previous = message }
}
try {
  const blockers = (await studio.check()).filter(check => check.status === 'blocked')
  assert.deepEqual(blockers, [], 'Install the LFM node/assets and restart the selected ComfyUI first.')
  const character = await studio.importCharacter(asset)
  studio.saveSetup(character.id, setupSchema.parse(JSON.parse(await readFile(resolve('tests', 'fixtures', 'bruiser-setup.json'), 'utf8'))))
  await studio.rig(character.id)
  assert.equal(studio.snapshot().characters[0].rigged, true)
  const request = { characterId: character.id, prompt: 'A person walks forward.', seconds: 2, seed: 42, steps: 25, inPlace: false }
  const parent = await studio.generate(request)
  assert.equal(parent.stage, 'complete', parent.message)
  const child = await studio.generate({ ...request, prompt: 'A person throws a right hook punch.', seconds: 2 })
  assert.equal(child.stage, 'complete', child.message)
  for (const job of [parent, child]) {
    assert.equal(job.textEncoder, 'lfm')
    await validateCharacterGlb(studio.output(job.id, 'animated.glb'), true)
    const manifest = JSON.parse(await readFile(join(root, 'jobs', job.id, 'manifest.json'), 'utf8'))
    assert.equal(manifest.textEncoder, 'lfm')
    assert.equal(manifest.clipFrames, 60)
  }
  const summary = { textEncoder: 'lfm', realLearnedMotion: true, root, walkJobId: parent.id, punchJobId: child.id,
    framesPerClip: 60, fps: 30, outputs: child.outputFiles, limitations: 'Independent clip/export validity is not a visual motion-quality or graph-continuity assessment.' }
  await writeFile(join(root, 'lfm-validation.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  if (process.argv.includes('--branch')) {
    const branch = await studio.generate({ ...request, prompt: 'A person throws a right hook punch.', steps: 100, seed: 43, parentJobId: parent.id })
    assert.equal(branch.stage, 'complete', branch.message)
    await validateCharacterGlb(studio.output(branch.id, 'animated.glb'), true)
    console.log('Branch endpoint continuity and skinned export passed:', branch.id)
  }
} finally {
  await studio.dispose()
}
