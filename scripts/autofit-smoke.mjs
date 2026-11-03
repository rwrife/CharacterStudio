import { _electron as electron, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import assert from 'node:assert/strict'
import { boxHumanoid, boxMesh, encodeGlb } from '../tests/fixtures/humanoid-mesh.ts'
import { fitLandmarks } from '../src/shared/landmark-fit.ts'
import { defaultLandmarks } from '../src/shared/rig.ts'

// Procedural box meshes exercise the desktop auto-fit control. They say nothing about rig quality on real characters.
const directory = await mkdtemp(join(tmpdir(), 'studio-autofit-ui-'))
const character = (name, mesh) => ({
  record: { id: randomUUID(), name, importedAt: new Date().toISOString(), previewUrl: '', vertices: mesh.positions.length / 3,
    meshes: 1, warnings: [], rigged: false, setup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() } },
  mesh
})
const humanoid = character('Box humanoid fixture', boxHumanoid())
const block = character('Box block fixture', boxMesh([[-0.3, 0, -0.2, 0.3, 2, 0.2]]))
const lyingMesh = boxHumanoid()
for (let i = 0; i < lyingMesh.positions.length; i += 3) {
  const y = lyingMesh.positions[i + 1], z = lyingMesh.positions[i + 2]
  lyingMesh.positions[i + 1] = z; lyingMesh.positions[i + 2] = -y
}
const sideways = character('Sideways humanoid fixture', lyingMesh)
for (const { record, mesh } of [humanoid, block, sideways]) {
  await mkdir(join(directory, 'characters', record.id), { recursive: true })
  await writeFile(join(directory, 'characters', record.id, 'preview.glb'), encodeGlb(mesh))
}
await writeFile(join(directory, 'studio.json'), JSON.stringify({
  settings: { comfyUrl: 'http://127.0.0.1:9', comfyRoot: directory, comfyOutput: join(directory, 'output'), blenderPath: join(directory, 'unused-blender.exe') },
  characters: [humanoid.record, block.record, sideways.record], jobs: [], plans: [], batches: []
}))
const expected = fitLandmarks(humanoid.mesh, [0, 0, 0]).landmarks
const shown = point => point.map(value => String(Number(value.toFixed(3))))

let app, client
try {
  app = await electron.launch({ args: ['.', '--mcp'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  const page = await app.firstWindow()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  client = new Client({ name: 'autofit-regression', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve('scripts', 'mcp-client.mjs'), '--connection', join(directory, 'mcp-connection.json')]
  }))
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, JSON.stringify(result.content))
    return JSON.parse(result.content[0].text)
  }
  const ui = () => call('studio_get_ui')
  const control = async match => {
    const matches = (await ui()).elements.filter(el => typeof match === 'string' ? el.name === match : match.test(el.name))
    assert.equal(matches.length, 1, `Expected one control: ${match}`)
    return matches[0]
  }
  const click = async match => call('studio_click', { ref: (await control(match)).ref })
  const joint = async () => Promise.all(['Joint X', 'Joint Y', 'Joint Z'].map(async name => (await control(name)).value))
  const stored = async id => (await call('studio_get_state')).characters.find(c => c.id === id).setup
  const until = async probe => expect.poll(probe, { timeout: 20000, intervals: [100, 250] }).toBeTruthy()
  const prepare = async (name, landmark) => {
    await click('Import character')
    await click(new RegExp(`^${name}`))
    await click('Fit & skin')
    await call('studio_select', { ref: (await control('Selected landmark')).ref, values: [landmark] })
  }

  await prepare(humanoid.record.name, 'LeftHand')
  assert.deepEqual(await joint(), shown(defaultLandmarks().LeftHand))
  await click('Auto-fit landmarks to mesh')
  await until(async () => (await ui()).alerts.some(text => text.startsWith('Landmarks fitted to the mesh.')))
  assert.deepEqual(await joint(), shown(expected.LeftHand), 'The visible joint fields show the fitted hand.')
  assert.notDeepEqual(expected.LeftHand, defaultLandmarks().LeftHand)
  await call('studio_select', { ref: (await control('Selected landmark')).ref, values: ['RightFoot'] })
  assert.deepEqual(await joint(), shown(expected.RightFoot))
  assert.deepEqual(await stored(humanoid.record.id), humanoid.record.setup, 'Auto-fit is a suggestion until the fit is saved.')
  await click('Save fit without rigging')
  await until(async () => isDeepStrictEqual((await stored(humanoid.record.id)).landmarks, expected))

  await prepare(block.record.name, 'Hips')
  const before = await joint()
  await click('Auto-fit landmarks to mesh')
  await until(async () => (await ui()).alerts.some(text => /^Auto-fit could not place the joints: .+ Your current landmarks were kept\.$/.test(text)))
  assert.deepEqual(await joint(), before, 'A failed fit must leave the landmarks untouched.')
  assert.equal((await ui()).elements.some(el => el.name === 'Save fit without rigging'), false, 'A failed fit must not mark the setup as changed.')
  assert.deepEqual(await stored(block.record.id), block.record.setup)

  await prepare(sideways.record.name, 'Hips')
  await click('Front view')
  await click('Dismiss error')
  await expect(page.getByText('Loading character geometry…', { exact: true })).toBeHidden()
  const sourceFile = join(directory, 'characters', sideways.record.id, 'preview.glb')
  const original = await readFile(sourceFile)
  const image = async () => {
    const bounds = await page.locator('[data-testid=viewport] canvas').boundingBox()
    assert.ok(bounds)
    return page.screenshot({ clip: {
      x: bounds.x + bounds.width * 0.15, y: bounds.y + bounds.height * 0.15,
      width: bounds.width * 0.7, height: bounds.height * 0.7
    } })
  }
  const beforeImage = await image()
  await click('Rotate model X +90 degrees')
  assert.equal((await control('Rotate X')).value, '90')
  await click('Dismiss message')
  await until(async () => !(await image()).equals(beforeImage))
  assert.deepEqual(await joint(), shown(defaultLandmarks().Hips), 'Reorienting does not silently replace landmark edits.')
  assert.deepEqual(await stored(sideways.record.id), sideways.record.setup, 'Orientation is only a preview before saving.')
  await click('Discard fit changes')
  assert.equal((await control('Rotate X')).value, '0')
  await click('Dismiss message')
  await until(async () => (await image()).equals(beforeImage))
  await click('Rotate model Z -90 degrees')
  assert.equal((await control('Rotate Z')).value, '-90')
  await click('Reset model orientation')
  for (const axis of ['X', 'Y', 'Z']) assert.equal((await control(`Rotate ${axis}`)).value, '0')
  await click('Rotate model Y +90 degrees')
  await click('Turn model around (180°)')
  assert.equal((await control('Rotate Y')).value, '-90', 'Quarter-turns wrap to valid saved angles.')
  await click('Rotate model Y +90 degrees')
  await call('studio_select', { ref: (await control('Rotate Z')).ref, values: ['90'] })
  assert.equal((await control('Rotate Z')).value, '90', 'Absolute angle selection remains available.')
  await click('Reset model orientation')
  await click('Rotate model X +90 degrees')
  await click('Auto-fit landmarks to mesh')
  await until(async () => (await ui()).alerts.some(text => text.startsWith('Landmarks fitted to the mesh.')))
  const corrected = fitLandmarks(sideways.mesh, [90, 0, 0]).landmarks
  await call('studio_select', { ref: (await control('Selected landmark')).ref, values: ['LeftHand'] })
  assert.deepEqual(await joint(), shown(corrected.LeftHand), 'Auto-fit uses the corrected model frame.')
  await click('Save fit without rigging')
  await until(async () => isDeepStrictEqual((await stored(sideways.record.id)).rotation, [90, 0, 0]))
  assert.deepEqual((await stored(sideways.record.id)).landmarks, corrected)
  assert.deepEqual(await readFile(sourceFile), original, 'The original preview asset remains unchanged.')
  await client.close(); client = undefined
  await app.close(); app = undefined
  app = await electron.launch({ args: ['.', '--mcp'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  const restarted = await app.firstWindow()
  await restarted.getByRole('heading', { name: 'Character lab' }).waitFor()
  await restarted.getByRole('button', { name: 'Import character', exact: true }).click()
  await restarted.getByRole('button', { name: new RegExp(`^${sideways.record.name}`) }).click()
  await expect(restarted.getByRole('combobox', { name: 'Rotate X', exact: true })).toHaveValue('90')
  await expect(restarted.getByRole('combobox', { name: 'Rotate Y', exact: true })).toHaveValue('0')
  await expect(restarted.getByRole('combobox', { name: 'Rotate Z', exact: true })).toHaveValue('0')
  console.log('Auto-fit and reorientation MCP smoke passed: visible mesh correction, quarter-turns, reset/discard, oriented fitting, save/restart persistence and source preservation.')
} finally {
  await client?.close().catch(() => {})
  await app?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
