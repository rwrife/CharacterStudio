import { _electron as electron } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { boxHumanoid, encodeGlb } from '../tests/fixtures/humanoid-mesh.ts'
import { defaultLandmarks } from '../src/shared/rig.ts'
import { MOCAP_MODELS } from '../src/shared/mocap.ts'

// Drives the visible Mocap tab over MCP with Chromium's fake camera. The fake feed contains no person, so this proves
// recording, import, the local WASM pose runtime and the visible no-person failure, not capture or retarget quality.
const directory = await mkdtemp(join(tmpdir(), 'studio-mocap-ui-'))
const cache = resolve('artifacts', 'mocap-cache')
const lite = MOCAP_MODELS.lite
// Set MOCAP_SMOKE_VIDEO to a clip of one full-body person and MOCAP_SMOKE_CHARACTER to a riggable T-pose FBX/GLB
// (for example artifacts\Bruiser_base.fbx) to also run a real capture, Blender rig and export.
const reference = process.env.MOCAP_SMOKE_VIDEO && process.env.MOCAP_SMOKE_CHARACTER ? resolve(process.env.MOCAP_SMOKE_VIDEO) : ''
const localBlender = resolve('.tools', 'blender-4.5.15-windows-arm64', 'blender.exe')
const blender = reference ? await access(localBlender).then(() => localBlender, () => '') : ''
const shots = process.env.MOCAP_SMOKE_SCREENSHOTS ? resolve(process.env.MOCAP_SMOKE_SCREENSHOTS) : ''
const characterId = randomUUID()
await mkdir(join(directory, 'characters', characterId), { recursive: true })
await writeFile(join(directory, 'characters', characterId, 'preview.glb'), encodeGlb(boxHumanoid()))
await writeFile(join(directory, 'studio.json'), JSON.stringify({
  settings: { comfyUrl: 'http://127.0.0.1:9', comfyRoot: directory, comfyOutput: join(directory, 'output'), blenderPath: blender || join(directory, 'unused-blender.exe') },
  characters: [{ id: characterId, name: 'Box humanoid fixture', importedAt: new Date().toISOString(), previewUrl: '', vertices: 96, meshes: 1, warnings: [], rigged: false, setup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() } }],
  jobs: [], plans: [], batches: []
}))
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const cachedModel = join(cache, 'pose_landmarker_lite.task')
const seeded = await sha256(cachedModel).then(hash => hash === lite.sha256, () => false)
if (seeded) {
  await mkdir(join(directory, 'models', 'mocap'), { recursive: true })
  await copyFile(cachedModel, join(directory, 'models', 'mocap', 'pose_landmarker_lite.task'))
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (probe, description, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(150) }
  throw new Error(`Timed out: ${description}`)
}
let app, client, passed = false
const errors = []
try {
  app = await electron.launch({
    args: ['.', '--mcp', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000
  })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  const connection = join(directory, 'mcp-connection.json')
  await until(() => access(connection).then(() => true, () => false), 'MCP connection file')
  client = new Client({ name: 'mocap-smoke', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('scripts', 'mcp-client.mjs'), '--connection', connection] }))
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
    return JSON.parse(result.content[0].text)
  }
  const ui = () => call('studio_get_ui')
  const matching = (state, name, role) => state.elements.filter(el => (name instanceof RegExp ? name.test(el.name) : el.name === name) && (!role || el.role === role))
  const locate = (name, role = 'button', timeout) => until(async () => {
    const found = matching(await ui(), name, role)
    assert.ok(found.length < 2, `Ambiguous ${role}: ${name}`)
    return found.length === 1 && !found[0].disabled ? found[0] : false
  }, `enabled ${role} ${name}`, timeout)
  const click = async (name, role = 'button', timeout) => call('studio_click', { ref: (await locate(name, role, timeout)).ref })
  const alert = (pattern, timeout) => until(async () => (await ui()).alerts.find(text => pattern.test(text)), `alert ${pattern}`, timeout)
  // Long Blender steps fail fast with the visible error instead of waiting for a timeout.
  const settle = (probe, description, timeout) => until(async () => {
    const state = await ui()
    if (matching(state, 'Dismiss error').length) throw new Error(`${description} failed: ${state.alerts.join(' | ')}`)
    return probe(state)
  }, description, timeout)
  const mocap = async () => (await call('studio_get_state')).mocap

  await click('Mocap', 'tab')
  await page.getByRole('heading', { name: 'Capture motion' }).waitFor()
  let state = await ui()
  assert.equal(matching(state, 'Animator character library', 'aside').length, 0, 'Only the Mocap workspace is visible.')
  assert.equal(matching(state, 'Mocap', 'tab')[0]?.selected, 'true')
  assert.equal(matching(state, 'Step 1: Import video (Current step)').length, 1, 'The stepper starts at import.')
  assert.equal(matching(state, /^Step 3: Review/)[0]?.disabled, true, 'Review waits for a capture.')
  assert.equal(matching(state, /^Step 4: Send to Animator/)[0]?.disabled, true, 'Sending waits for a capture.')
  assert.equal(matching(state, 'Capture motion', 'button')[0]?.disabled, true, 'Capture waits for a video and a model.')
  assert.equal(matching(state, 'Send to Animator', 'button').length, 0, 'The send step is hidden until reached.')
  const badge = matching(state, /^Video pose capture provider: /)
  assert.equal(badge.length, 1)
  assert.match(badge[0].name, /built-in|local/i, 'Capture defaults to the built-in local route.')
  await click('Capture options', 'summary')
  assert.ok(matching(await ui(), 'Use Pose Lite', 'radio')[0]?.checked, 'Pose Lite is the default model.')

  // Record a real WebM take from the (fake) webcam through the visible controls.
  await click('Record with webcam')
  await click('Record take')
  await alert(/^\d$/, 5000)
  await locate('Stop and save take', 'button', 10000)
  await alert(/^REC [1-9]\d*s/, 10000)
  await delay(1500)
  await click('Stop and save take')
  await alert(/Webcam take saved on this PC/, 20000)
  const recorded = (await mocap()).takes[0]
  assert.equal(recorded.source, 'webcam')
  assert.ok(recorded.bytes > 1000, 'The recording contains video data.')
  assert.equal(matching(await ui(), 'Live camera preview').length, 0, 'Saving closes the camera.')
  await locate('Step 2: Capture motion (Current step)')

  // Import the same footage as a file through the visible in-app file dialog.
  const clip = join(directory, 'fake camera clip.webm')
  await copyFile(join(directory, 'mocap', 'takes', recorded.id, 'source.webm'), clip)
  await click('Change video')
  await call('studio_set_value', { ref: (await locate('Absolute file path', 'textbox')).ref, value: clip })
  await click('Use selected paths')
  await alert(/Video imported/)
  const imported = (await mocap()).takes[0]
  assert.deepEqual((await mocap()).takes.map(t => t.name), ['fake camera clip', recorded.name])

  // Clip range: typed times are validated and committed, and the In handle responds to the keyboard.
  const end = await locate('Clip end', 'textbox')
  await call('studio_set_value', { ref: end.ref, value: '0:00.8' })
  await call('studio_press_key', { ref: end.ref, key: 'Enter' })
  await until(async () => matching(await ui(), 'Clip end', 'textbox')[0]?.value === '00:00.8', 'clip end committed')
  await call('studio_press_key', { ref: (await locate('Clip in point', 'slider')).ref, key: 'ArrowRight', modifiers: ['shift'] })
  await until(async () => /^00:00\.[5-7]$/.test(matching(await ui(), 'Clip start', 'textbox')[0]?.value ?? ''), 'clip start stepped and clamped before the end')
  await call('studio_set_value', { ref: (await locate('Clip start', 'textbox')).ref, value: '5' })
  await call('studio_press_key', { ref: (await locate('Clip start', 'textbox')).ref, key: 'Enter' })
  await alert(/start|end|clip/i, 5000)
  await call('studio_set_value', { ref: (await locate('Clip start', 'textbox')).ref, value: '0' })
  await call('studio_press_key', { ref: (await locate('Clip start', 'textbox')).ref, key: 'Enter' })
  await until(async () => matching(await ui(), 'Clip start', 'textbox')[0]?.value === '00:00.0', 'clip start reset')

  if (!seeded) {
    await click('Download Pose Lite')
    await until(async () => (await mocap()).models.lite.status === 'ready', 'Pose Lite download', 120000)
    await mkdir(cache, { recursive: true })
    await copyFile(join(directory, 'models', 'mocap', 'pose_landmarker_lite.task'), cachedModel)
  }
  await until(async () => (await mocap()).models.lite.status === 'ready', 'Pose Lite ready')

  // The local WASM pose model runs over the clip; the fake feed has no person and must not save a capture.
  await click('Capture motion')
  const failure = await alert(/^A person was detected in only 0 of \d+ frames\./, 120000)
  assert.match(failure, /No capture was saved\./)
  assert.equal((await mocap()).takes[0].capture, undefined)
  assert.equal(matching(await ui(), /^Step 3: Review/)[0]?.disabled, true, 'The take is still uncaptured.')

  await click('Saved captures (2)')
  await click('Delete take fake camera clip')
  await click('Confirm delete fake camera clip')
  await until(async () => (await mocap()).takes.length === 1, 'take deletion')
  assert.equal((await mocap()).takes[0].id, recorded.id, 'Only the selected take is deleted.')
  await assert.rejects(access(join(directory, 'mocap', 'takes', imported.id)))

  // Optional real performance: import a video with a person, capture locally, rig with Blender and send to Animator.
  if (reference && blender) {
    await click('Change video')
    await call('studio_set_value', { ref: (await locate('Absolute file path', 'textbox')).ref, value: reference })
    await click('Use selected paths')
    await alert(/Video imported/)
    await click('Capture motion')
    await alert(/^Motion captured: a person was detected in \d+ of \d+ frames/, 300000)
    const captured = (await mocap()).takes[0].capture
    assert.ok(captured && captured.detected / captured.frames >= 0.5)
    await locate('Step 3: Review (Current step)')
    await delay(1200)
    if (shots) await page.screenshot({ path: join(shots, 'mocap-review.png') })
    await click('Continue to Send to Animator')
    await locate('Step 4: Send to Animator (Current step)')
    assert.equal(matching(await ui(), 'Send to Animator', 'button')[0]?.disabled, true, 'Unrigged characters cannot receive mocap.')
    const tpose = resolve(process.env.MOCAP_SMOKE_CHARACTER)
    await click(/^Import T-pose/)
    await call('studio_set_value', { ref: (await locate('Absolute file path', 'textbox')).ref, value: tpose })
    await click('Use selected paths')
    await until(async () => (await call('studio_get_state')).characters.length === 2, 'T-pose import', 300000)
    await click('Build skin + rig', 'button', 300000)
    await settle(state => state.alerts.some(text => /Skin weights validated/.test(text)), 'Build skin + rig', 900000)
    await click('Send to Animator')
    await settle(state => matching(state, 'Animator', 'tab')[0]?.selected === 'true' && matching(state, 'Animator character library', 'aside').length === 1, 'Send to Animator', 1800000)
    await delay(1500)
    if (shots) await page.screenshot({ path: join(shots, 'mocap-animator.png') })
    const exported = (await call('studio_get_state')).jobs.find(job => job.kind === 'mocap')
    assert.equal(exported?.stage, 'complete')
    assert.ok(exported.outputFiles.includes('animated.fbx') && exported.outputFiles.includes('animated.glb'))
    const fbx = await readFile(join(directory, 'jobs', exported.id, 'animated.fbx'))
    assert.ok(fbx.subarray(0, 18).toString() === 'Kaydara FBX Binary', 'The export is a binary FBX.')
    assert.ok(matching(await ui(), new RegExp(`^${exported.label}`), 'button').length >= 1, 'The mocap take is listed in Animator.')
  }
  assert.deepEqual(errors, [])
  console.log(`Mocap MCP smoke passed: webcam recording, video import, clip range, ${seeded ? 'cached' : 'downloaded'} Pose Lite, local capture failure, take deletion${reference && blender ? ', real capture, Blender rig and Send to Animator' : ''} through the visible desktop.`)
  passed = true
} finally {
  await client?.close().catch(() => {})
  await app?.close().catch(() => {})
  if (passed || !process.env.MOCAP_SMOKE_KEEP) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  else console.error(`Kept failed workspace: ${directory}`)
}
