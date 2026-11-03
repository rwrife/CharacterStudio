import { _electron as electron, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { basicHandSetup, encodeWristFixture } from '../tests/fixtures/humanoid-mesh.ts'
import { defaultLandmarks } from '../src/shared/rig.ts'
import { defaultHandPose } from '../src/shared/hand-pose.ts'

const directory = await mkdtemp(join(tmpdir(), 'studio-hand-ui-'))
const id = randomUUID(), takeId = randomUUID(), rigDirectory = join(directory, 'rig')
const takeDirectory = join(directory, 'jobs', takeId)
await mkdir(join(directory, 'characters', id), { recursive: true })
await mkdir(rigDirectory)
await mkdir(takeDirectory, { recursive: true })
const rigBytes = encodeWristFixture(), takeBytes = encodeWristFixture(true)
await writeFile(join(rigDirectory, 'rigged.glb'), rigBytes)
await writeFile(join(directory, 'characters', id, 'preview.glb'), rigBytes)
await writeFile(join(takeDirectory, 'animated.glb'), takeBytes)
await writeFile(join(takeDirectory, 'clip.glb'), takeBytes)
const character = {
  id, name: 'Procedural wrist fixture', importedAt: new Date().toISOString(), previewUrl: '', vertices: 88,
  meshes: 1, warnings: ['Procedural box fixture; not a generated character or evidence of finger rigging.'], rigged: true,
  rigDirectory, setup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() }
}
const job = { id: takeId, characterId: id, characterName: character.name, kind: 'generate', stage: 'complete',
  message: 'Analytic fixture only', prompt: 'Saved fixture take', progress: 100, seconds: 1, seed: 1,
  createdAt: new Date().toISOString(), outputFiles: ['animated.glb', 'clip.glb'], inPlace: false }
const fingerId = randomUUID(), fingerDirectory = join(directory, 'finger-rig'), fingerSetup = basicHandSetup()
await mkdir(fingerDirectory)
await mkdir(join(directory, 'characters', fingerId), { recursive: true })
const fingerBytes = encodeWristFixture(false, fingerSetup)
await writeFile(join(fingerDirectory, 'rigged.glb'), fingerBytes)
await writeFile(join(directory, 'characters', fingerId, 'preview.glb'), fingerBytes)
const fingerCharacter = { ...character, id: fingerId, name: 'Three-chain hand fixture', rigDirectory: fingerDirectory, setup: fingerSetup }
await writeFile(join(directory, 'studio.json'), JSON.stringify({
  settings: { comfyUrl: 'http://127.0.0.1:9', comfyRoot: directory, comfyOutput: join(directory, 'output'), blenderPath: join(directory, 'unused-blender.exe') },
  characters: [character, fingerCharacter], jobs: [job], plans: [], batches: []
}))
let app, client, page
const start = async () => {
  app = await electron.launch({ args: ['.', '--mcp'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  page = await app.firstWindow()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  client = new Client({ name: 'hand-pose-regression', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve('scripts', 'mcp-client.mjs'), '--connection', join(directory, 'mcp-connection.json')]
  }))
}
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, JSON.stringify(result.content))
  return JSON.parse(result.content[0].text)
}
const control = async name => {
  const elements = (await call('studio_get_ui')).elements.filter(el => typeof name === 'string' ? el.name === name : name.test(el.name))
  assert.equal(elements.length, 1, `Expected one control: ${name}`)
  return elements[0]
}
const click = async name => call('studio_click', { ref: (await control(name)).ref })
const fill = async (name, value) => call('studio_set_value', { ref: (await control(name)).ref, value })
const until = probe => expect.poll(probe, { timeout: 20000, intervals: [100, 250] }).toBeTruthy()
const image = async side => {
  const bounds = await page.locator('[data-testid=viewport] canvas').boundingBox()
  assert.ok(bounds)
  // Exclude overlay controls/focus rings; observe only the rendered character.
  return page.screenshot({ clip: {
    x: bounds.x + bounds.width * (side === 'left' ? 0.5 : 0.15),
    y: bounds.y + bounds.height * 0.2,
    width: bounds.width * (side ? 0.35 : 0.7), height: bounds.height * 0.5
  } })
}
const state = () => call('studio_get_state')
try {
  await start()
  for (const side of ['left', 'right']) {
    const button = page.getByRole('button', { name: `Focus ${side} hand`, exact: true })
    await expect(button).toHaveText('')
    await expect(button.locator('svg')).toHaveClass(/lucide-hand/)
    await expect(button.locator('svg')).toHaveCSS('transform', side === 'left' ? 'matrix(-1, 0, 0, 1, 0, 0)' : 'none')
  }
  await until(async () => !(await control('Hand pose & rig detail')).disabled)
  await click('Hand pose & rig detail')
  await click('Front view')
  await expect(page.getByText('Loading character geometry…', { exact: true })).toBeHidden()
  const before = await image(), rightBefore = await image('right'), originalState = await state()
  await fill('Left wrist Z', '-70')
  await until(async () => !(await image()).equals(before))
  assert.deepEqual(await image('right'), rightBefore, 'Only the edited hand should change.')
  assert.equal((await control('Right wrist Z')).value, '0')
  assert.equal((await control('Original')).disabled, true, 'Unsaved changes cannot be lost by navigation.')
  const blocked = await client.callTool({ name: 'studio_click', arguments: { ref: (await control('Original')).ref } })
  assert.equal(blocked.isError, true)
  assert.equal((await state()).characters[0].handPose, undefined, 'Preview must not mutate saved settings.')
  await click('Discard hand pose changes')
  await until(async () => (await image()).equals(before))
  await fill('Left wrist X', '25')
  await fill('Left wrist Y', '-35')
  await fill('Left wrist Z', '-60')
  await click('Copy left rotation to right')
  assert.equal((await control('Right wrist X')).value, '25')
  await fill('Right wrist Z', '45')
  const expected = { ...defaultHandPose(), left: [25, -35, -60], right: [25, -35, 45] }
  await click('Save hand pose')
  await until(async () => JSON.stringify((await state()).characters[0].handPose) === JSON.stringify(expected))
  assert.equal((await state()).characters[0].rigged, true)
  assert.equal((await state()).characters[0].rigPreviewUrl, originalState.characters[0].rigPreviewUrl)
  assert.deepEqual((await state()).jobs, originalState.jobs)
  assert.deepEqual(await readFile(join(rigDirectory, 'rigged.glb')), rigBytes)
  assert.deepEqual(await readFile(join(takeDirectory, 'animated.glb')), takeBytes)
  const invalid = await client.callTool({ name: 'studio_set_value', arguments: { ref: (await control('Left wrist X')).ref, value: '181' } })
  assert.equal(invalid.isError, true, 'MCP must enforce the field bounds before editing.')
  assert.deepEqual((await state()).characters[0].handPose, expected)
  await click('Reset wrist rotations')
  assert.equal((await control('Left wrist Z')).value, '0')
  assert.equal((await control('Right wrist Z')).value, '0')
  await click('Discard hand pose changes')
  await client.close(); client = undefined
  await app.close(); app = undefined
  await start()
  await until(async () => !(await control('Hand pose & rig detail')).disabled)
  await click('Hand pose & rig detail')
  assert.equal((await control('Left wrist Z')).value, '-60')
  assert.equal((await control('Right wrist Z')).value, '45')
  assert.deepEqual((await state()).characters[0].handPose, expected)
  assert.equal((await state()).jobs.length, 1, 'No skin rebuild or inference job is needed for pose edits.')
  await click('Front view')
  await expect(page.getByText('Loading character geometry…', { exact: true })).toBeHidden()
  await mkdir(resolve('docs', 'screenshots'), { recursive: true })
  await page.screenshot({ path: resolve('docs', 'screenshots', 'hand-pose.png') })
  await click('Back to motion controls')
  await click(/^Saved fixture take/)
  await expect(page.getByRole('button', { name: 'Pause animation', exact: true })).toBeEnabled()
  await click('Pause animation')
  await call('studio_set_value', { ref: (await control('Animation timeline')).ref, value: '0' })
  const completedPreview = await image()
  await click('Hand pose & rig detail')
  await click('Reset wrist rotations')
  assert.equal((await control('Preview output')).disabled, true, 'Output selection must not hide an unsaved hand preview.')
  const blockedPreview = await client.callTool({ name: 'studio_select', arguments: { ref: (await control('Preview output')).ref, values: ['clip'] } })
  assert.equal(blockedPreview.isError, true)
  await click('Save hand pose')
  await until(async () => JSON.stringify((await state()).characters[0].handPose) === JSON.stringify(defaultHandPose()))
  await click('Dismiss message')
  await click('Back to motion controls')
  await click(/^Saved fixture take/)
  await expect(page.getByRole('button', { name: 'Pause animation', exact: true })).toBeEnabled()
  await click('Pause animation')
  await call('studio_set_value', { ref: (await control('Animation timeline')).ref, value: '0' })
  await until(async () => (await image()).equals(completedPreview))
  await click('Hand pose & rig detail')
  await call('studio_select', { ref: (await control('Preview output')).ref, values: ['clip'] })
  await expect(page.getByRole('region', { name: 'Hand pose controls' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Pause animation', exact: true })).toBeEnabled()
  await click(/^Three-chain hand fixture/)
  await click('Hand pose & rig detail')
  await click('Front view')
  await expect(page.getByText('Loading character geometry…', { exact: true })).toBeHidden()
  const fingersBefore = await image(), opposite = await image('right')
  await fill('Left index', '0.85')
  await until(async () => !(await image()).equals(fingersBefore))
  assert.deepEqual(await image('right'), opposite, 'Finger edits must not move the opposite hand.')
  await fill('Left thumb', '0.6')
  await fill('Left opposition', '0.4')
  await fill('Left fingers', '0.7')
  await click('Discard hand pose changes')
  await until(async () => (await image()).equals(fingersBefore))
  await click('Left Fist')
  await click('Save hand pose')
  await until(async () => (await state()).characters.find(c => c.id === fingerId).handPose?.fingers.left.index === 1)
  await click('Dismiss message')
  await click('Focus left hand')
  await call('studio_scroll', { ref: (await control('Animator motion controls')).ref, y: -350 })
  await page.screenshot({ path: resolve('docs', 'screenshots', 'hand-three-chain.png') })
  const posed = (await state()).characters.find(c => c.id === fingerId)
  assert.equal(posed.rigged, true)
  assert.deepEqual(await readFile(join(fingerDirectory, 'rigged.glb')), fingerBytes)
  await call('studio_set_checked', { ref: (await control('Animate fingers over clip')).ref, checked: true })
  await fill('Hand key preview time', '0.5')
  await fill('Left index', '0.2')
  const middleKey = await image()
  await fill('Hand key preview time', '0')
  assert.equal((await control('Left index')).value, '1')
  await until(async () => !(await image()).equals(middleKey))
  assert.equal((await control('Bake fixed grip as new wrist-only character')).disabled, true)
  await click('Save hand pose')
  await until(async () => (await state()).characters.find(c => c.id === fingerId).handPose?.keyframes.length === 3)
  await client.close(); client = undefined
  await app.close(); app = undefined
  await start()
  await click(/^Three-chain hand fixture/)
  await click('Hand pose & rig detail')
  assert.equal((await control('Left index')).value, '1')
  assert.equal((await control('Right index')).value, '0')
  await click('Motion library & batches')
  await call('studio_set_checked', { ref: (await control('Override character finger pose for this node')).ref, checked: true })
  await click('Open-close-open hand animation')
  await click('Save graph')
  await until(async () => (await state()).plans[0]?.nodes[0].fingerPose?.keyframes.length === 3)
  assert.equal((await state()).plans[0].nodes[0].fingerPose.keyframes[1].fingers.left.index, 1)
  await click('Close motion library')
  await click('Change hand rig detail & fitting')
  const unavailable = await client.callTool({ name: 'studio_select', arguments: { ref: (await control('Left hand rig detail')).ref, values: ['individual'] } })
  assert.equal(unavailable.isError, true)
  await call('studio_select', { ref: (await control('Selected landmark')).ref, values: ['LeftIndex2'] })
  await fill('Joint Y', '1.505')
  await call('studio_select', { ref: (await control('Right hand rig detail')).ref, values: ['wrist'] })
  await click('Save fit without rigging')
  await until(async () => !(await state()).characters.find(c => c.id === fingerId).rigged)
  const fitted = (await state()).characters.find(c => c.id === fingerId)
  assert.equal(fitted.setup.landmarks.LeftIndex2[1], 1.505)
  assert.equal(fitted.setup.hands.right.detail, 'wrist')
  assert.equal(fitted.setup.hands.left.detail, 'basic')
  assert.equal(fitted.handPose.fingers.left.index, 1)
  console.log('Hand pose MCP smoke passed: visible wrist/finger deformation, fitted detail, keyed preview and graph overrides, immutable takes, no reskinning, and restart persistence.')
} finally {
  await client?.close().catch(() => {})
  await app?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
