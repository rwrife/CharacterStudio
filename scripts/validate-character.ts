import { resolve, join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { Studio } from '../src/main/studio'
import { runProcess } from '../src/main/process'
import assert from 'node:assert/strict'

const root = process.argv[2] ? resolve(process.argv[2]) : resolve('artifacts', 'validation-state')
const studio = new Studio(root, resolve('.'))
let stage = ''
studio.onUpdate = s => { const job = s.jobs[0]; if (job && job.message !== stage) { stage = job.message; console.log(job.stage, stage) } }
const source = resolve('artifacts', 'Bruiser_base.fbx')
let character = studio.snapshot().characters.find(c => c.name === 'Bruiser_base.fbx')
if (!character) character = await studio.importCharacter(source)
const setup = JSON.parse(await readFile(resolve('tests', 'fixtures', 'bruiser-setup.json'), 'utf8'))
await studio.saveSetup(character.id, setup)
await studio.rig(character.id)
const state = JSON.parse(await readFile(join(root, 'studio.json'), 'utf8'))
const stored = state.characters.find((c: { id: string }) => c.id === character!.id)
const report = JSON.parse(await readFile(join(stored.rigDirectory, 'rig-report.json'), 'utf8'))
assert.equal(report.vertices, report.weightedVertices)
assert.ok(report.vertices > 100000)
const output = resolve('artifacts', 'bruiser-analytic-test')
await mkdir(output, { recursive: true })
const python = join(state.settings.comfyRoot, 'venv', 'Scripts', 'python.exe')
const kimodo = join(state.settings.comfyRoot, 'custom_nodes', 'ComfyUI-Kimodo', 'kimodo')
console.log(await runProcess(python, [resolve('tests', 'make_test_motion.py'), kimodo, join(output, 'test-motion.npz')]))
console.log(await runProcess(python, [resolve('backend', 'prepare_motion.py'), '--kimodo', kimodo, '--input', join(output, 'test-motion.npz'), '--output', join(output, 'test-motion.json'), '--fps', '30']))
const request = join(output, 'request.json')
await writeFile(request, JSON.stringify({
  command: 'animate', input: join(stored.rigDirectory, 'rigged.blend'),
  motion: join(output, 'test-motion.json'), output, inPlace: false
}))
console.log(await runProcess(state.settings.blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', resolve('backend', 'character.py'), '--', request]))
const animated = JSON.parse(await readFile(join(output, 'animation-report.json'), 'utf8'))
assert.equal(animated.frames, 60)
assert.ok(animated.sampledMeshDisplacement > 0.02)
console.log('Actual Bruiser rig + analytic retarget passed:', animated)
console.log('This verifies the character backend only. It is NOT a successful text-generated ComfyUI clip.')
