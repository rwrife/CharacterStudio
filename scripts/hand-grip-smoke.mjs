import { _electron as electron, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { bundledBlenderPath } from '../src/main/native-runtime.ts'
import { validateCharacterGlb } from '../src/main/export-validation.ts'

const directory = await mkdtemp(join(tmpdir(), 'studio-fixed-grip-ui-'))
const id = randomUUID(), rigDirectory = join(directory, 'characters', id)
const blenderPath = bundledBlenderPath(resolve('.'))
let app, client, page
const start = async () => {
  app = await electron.launch({ args: ['.', '--mcp'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1',
    STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  page = await app.firstWindow()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  client = new Client({ name: 'fixed-grip-regression', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('scripts', 'mcp-client.mjs'), '--connection', join(directory, 'mcp-connection.json')] }))
}
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, JSON.stringify(result.content))
  return JSON.parse(result.content[0].text)
}
const control = async name => {
  const matches = (await call('studio_get_ui')).elements.filter(el => el.name === name)
  assert.equal(matches.length, 1, `Expected one control: ${name}`)
  return matches[0]
}
const click = async name => call('studio_click', { ref: (await control(name)).ref })
const fill = async (name, value) => call('studio_set_value', { ref: (await control(name)).ref, value })
const state = () => call('studio_get_state')
const until = probe => expect.poll(probe, { timeout: 60000, intervals: [100, 250, 500] }).toBeTruthy()
try {
  execFileSync(blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
    '--python', resolve('tests', 'create_hand_fixture.py'), '--', rigDirectory], { stdio: 'pipe' })
  const setup = JSON.parse(await readFile(join(rigDirectory, 'setup.json'), 'utf8'))
  await writeFile(join(directory, 'studio.json'), JSON.stringify({
    settings: { comfyUrl: 'http://127.0.0.1:9', comfyRoot: directory, comfyOutput: join(directory, 'output'), blenderPath },
    characters: [{ id, name: 'Native three-chain fixture', importedAt: new Date().toISOString(), previewUrl: '', vertices: 1,
      meshes: 1, warnings: ['Procedural native fixture; not a production asset.'], rigged: true, rigDirectory, setup }],
    jobs: [], plans: [], batches: []
  }))
  const sourceBytes = await readFile(join(rigDirectory, 'rigged.blend'))
  await start()
  await until(async () => !(await control('Hand pose & rig detail')).disabled)
  await click('Hand pose & rig detail')
  await fill('Left wrist X', '15')
  await click('Left Fist')
  assert.equal((await control('Bake fixed grip as new wrist-only character')).disabled, true, 'Unsaved poses must not be baked.')
  await click('Save hand pose')
  await until(async () => !(await control('Bake fixed grip as new wrist-only character')).disabled)
  const original = (await state()).characters[0]
  await click('Bake fixed grip as new wrist-only character')
  await until(async () => (await state()).characters.length === 2)
  await until(async () => !(await control('Left wrist X')).disabled)
  const snapshot = await state(), variation = snapshot.characters.find(c => c.id !== id)
  assert.deepEqual(snapshot.characters.find(c => c.id === id), original)
  assert.deepEqual(await readFile(join(rigDirectory, 'rigged.blend')), sourceBytes)
  assert.equal(variation.fixedGrip.sourceCharacterId, id)
  assert.equal(variation.handPose.version, 1)
  assert.equal(variation.handPose.left[0], 15, 'Wrist rotations remain separate from baked finger geometry.')
  assert.equal(variation.setup.hands.left.detail, 'wrist')
  assert.equal(variation.setup.hands.right.detail, 'wrist')
  assert.notDeepEqual(variation.setup.landmarks.LeftHandEnd, original.setup.landmarks.LeftHandEnd,
    'Wrist-only fitting must retain the actual shortened wrist bone, not the original open fingertips.')
  assert.equal(snapshot.jobs.at(0).stage, 'complete')
  await click('Dismiss message')
  await click('Focus left hand')
  await call('studio_scroll', { ref: (await control('Animator motion controls')).ref, y: -2000 })
  await mkdir(resolve('docs', 'screenshots'), { recursive: true })
  await page.screenshot({ path: resolve('docs', 'screenshots', 'hand-fixed-grip.png') })
  const output = join(directory, 'fixed-grip-export.glb')
  await click('Export fixed-grip GLB')
  await until(async () => (await call('studio_get_ui')).modal === 'Save local file')
  await fill('Absolute file path', output)
  await click('Save selected file')
  await until(async () => (await call('studio_get_ui')).modal === null)
  await validateCharacterGlb(output, false)
  const bytes = await readFile(output)
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString())
  assert.equal(gltf.skins[0].joints.length, 22)
  assert.ok(!gltf.skins[0].joints.some(index => /^(Left|Right)(Thumb|Index|Fingers)\d$/.test(gltf.nodes[index].name ?? '')))
  await client.close(); client = undefined
  await app.close(); app = undefined
  await start()
  assert.equal((await state()).characters.length, 2)
  await until(async () => !(await control('Hand pose & rig detail')).disabled)
  await click('Hand pose & rig detail')
  assert.equal((await control('Left wrist X')).value, '15')
  assert.deepEqual((await state()).characters.find(c => c.id === id), original)
  console.log('Fixed-grip native desktop/MCP smoke passed: real Blender bake, separate variation, source preservation, 22-bone GLB export via visible file picker and restart persistence.')
} finally {
  await client?.close().catch(() => {})
  await app?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
