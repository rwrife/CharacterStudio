import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installDesignerModel } from '../src/main/model-download'
import { Designer, designConfigSchema } from '../src/main/designer'
import { designerModelPackages, needsDesignerModel, type DesignerModel } from '../src/shared/designer-models'
import type { DesignerReadiness, DesignRequest } from '../src/shared/designer'
import type { Settings } from '../src/shared/types'

const bytes = Buffer.from('TEST-ONLY model transfer fixture; not inference weights')
const model: DesignerModel = { ...designerModelPackages.background.models[0],
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
const request: DesignRequest = { title: 'Download fixture', description: 'Test character', style: 'Test style', seed: 42, steps: 20, referenceStrength: 0.3 }

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'studio-model-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'main.py'), '# TEST ONLY')
  return root
}
const installedPath = (root: string) => join(root, 'models', model.folder, model.file)
const transfer = (root: string, signal = new AbortController().signal, progress = (_: number) => {}) =>
  installDesignerModel(root, model, signal, progress)

test('downloads to the correct folder, checks size/hash, reports progress and reuses verified files', async t => {
  const root = await directory(t)
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(bytes))
  const progress: number[] = []
  await transfer(root, undefined, received => progress.push(received))
  assert.deepEqual(await readFile(installedPath(root)), bytes)
  assert.equal(progress.at(-1), bytes.length)
  assert.deepEqual(await readdir(join(root, 'models', model.folder)), [model.file])
  await transfer(root)
  assert.equal(network.mock.callCount(), 1, 'Verified files must not be downloaded twice')
})

test('conflicting files are not overwritten or downloaded', async t => {
  const root = await directory(t)
  await mkdir(join(root, 'models', model.folder), { recursive: true })
  await writeFile(installedPath(root), 'MY EXISTING MODEL')
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network call') })
  await assert.rejects(transfer(root), /not overwritten/)
  assert.equal(await readFile(installedPath(root), 'utf8'), 'MY EXISTING MODEL')
  assert.equal(network.mock.callCount(), 0)
})

for (const failure of ['checksum', 'truncated', 'oversized', 'content-length', 'http', 'redirect', 'network'] as const) {
  test(`${failure} failures do not publish weights or retain partial files`, async t => {
    const root = await directory(t)
    t.mock.method(globalThis, 'fetch', async () => {
      if (failure === 'network') throw new Error('Network unavailable')
      if (failure === 'http') return new Response('Denied', { status: 403 })
      if (failure === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://untrusted.example/weights' } })
      if (failure === 'content-length') return new Response(bytes, { headers: { 'content-length': '999' } })
      return new Response(failure === 'checksum' ? Buffer.alloc(bytes.length) : failure === 'truncated' ? bytes.subarray(0, 5) : Buffer.alloc(bytes.length + 1))
    })
    await assert.rejects(transfer(root))
    assert.deepEqual(await readdir(join(root, 'models', model.folder)), [])
  })
}

test('HTTPS redirects to the model CDN work without forwarding credentials', async t => {
  const root = await directory(t)
  const network = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(options?.headers, undefined)
    assert.equal(options?.redirect, 'manual')
    return String(url) === model.url ? new Response(null, { status: 302, headers: { location: 'https://cas-bridge.xethub.hf.co/fixture' } }) : new Response(bytes)
  })
  await transfer(root)
  assert.equal(network.mock.callCount(), 2)
})

test('cancellation removes the active partial file and preserves existing models', async t => {
  const root = await directory(t)
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes))
  await assert.rejects(transfer(root, controller.signal, () => controller.abort()))
  assert.deepEqual(await readdir(join(root, 'models', model.folder)), [])
})

test('model directory junctions cannot redirect downloads outside ComfyUI', async t => {
  const root = await directory(t), outside = await directory(t)
  await symlink(outside, join(root, 'models'), 'junction')
  await assert.rejects(transfer(root), /inside the saved ComfyUI folder/)
  assert.deepEqual(await readdir(outside), ['main.py'])
})

test('catalog uses pinned HTTPS safetensors, bounded filenames and SHA-256 checksums', () => {
  for (const entry of Object.values(designerModelPackages).flatMap(p => p.models)) {
    assert.match(entry.url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\//)
    assert.match(entry.file, /^[\w.-]+\.safetensors$/)
    assert.match(entry.folder, /^\w+$/)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
    assert.ok(entry.bytes > 0)
    assert.ok(entry.license && entry.page)
  }
})

async function designerFixture(t: TestContext, failAt = -1) {
  const root = await directory(t)
  const config = designConfigSchema.parse({ imageProfile: 'sd15', checkpoint: 'my-sd15.safetensors', controlnet: '',
    meshProfile: 'standard', meshCheckpoint: '', titleModel: '' })
  const settings: Settings = { comfyRoot: root, comfyOutput: join(root, 'output'), comfyUrl: 'http://127.0.0.1:8189', blenderPath: 'blender' }
  const ready: DesignerReadiness = { devices: [{ name: 'Test GPU', totalGB: 48, freeGB: 32 }], checkpoints: [config.checkpoint],
    titleModels: [], controlnets: [], ipadapters: [], clipVision: [], backgroundModels: [], diffusionModels: [], textEncoders: [], vaes: [] }
  let locked = false
  const calls: DesignerModel[] = []
  const designer = new Designer(root, root, new Map(), () => settings, () => {
    if (locked) throw new Error('Job slot locked')
    locked = true
    return () => { locked = false }
  }, () => {}, async () => Buffer.from('TEST-ONLY image'), async (_root, model, signal, progress) => {
    signal.throwIfAborted()
    assert.equal(locked, true)
    calls.push(model); progress(model.bytes)
    if (calls.length === failAt) throw new Error('Transfer interrupted')
    ready[model.choices].push(model.file)
  })
  designer.saveSettings(config)
  designer.readiness = async () => structuredClone(ready)
  return { root, config, designer, ready, calls, isLocked: () => locked }
}

test('BiRefNet failures expose a persisted download action without publishing output', async t => {
  const { root, designer } = await designerFixture(t)
  const image = join(root, 'pose.png')
  await writeFile(image, 'TEST ONLY')
  const id = await designer.importStage(image, { stage: 'tpose', brief: request, isolated: false })
  await assert.rejects(designer.run(id, 'tpose'), /BiRefNet/)
  const design = designer.snapshot().designs[0]
  assert.deepEqual(design.recovery, { package: 'background' })
  assert.equal(design.status, 'failed')
  assert.equal(design.tposeIsolated, false)
  assert.equal(design.modelUrl, undefined)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'designer.json'), 'utf8')).designs[0].recovery, { package: 'background' })
})

test('approved downloads select required files, refresh choices, persist settings and never rerun designs', async t => {
  const { root, config, designer, calls, isLocked } = await designerFixture(t)
  const before = designer.snapshot().designs
  let confirmed = false
  const installed = await designer.installModels('edit', async (label, models, destination) => {
    assert.match(label, /T-pose/)
    assert.equal(destination, root)
    assert.equal(models.length, 4)
    assert.equal(calls.length, 0)
    assert.throws(() => designer.saveSettings(config), /locked/)
    confirmed = true
    return true
  })
  assert.equal(confirmed, true)
  assert.equal(calls.length, 4)
  assert.equal(installed?.backgroundModel, 'birefnet.safetensors')
  assert.equal(installed?.editModel, config.editModel)
  assert.equal(installed?.checkpoint, config.checkpoint)
  assert.equal(JSON.parse(await readFile(join(root, 'designer.json'), 'utf8')).config.backgroundModel, 'birefnet.safetensors')
  assert.deepEqual(designer.snapshot().designs, before)
  assert.equal(designer.snapshot().modelDownload?.status, 'complete')
  assert.equal(isLocked(), false)
  await designer.installModels('edit', async () => { throw new Error('Already selected; no approval needed') })
  assert.equal(calls.length, 4)
})

test('cancelled approval and invalid package requests leave configuration and files untouched', async t => {
  const { config, designer, calls, isLocked } = await designerFixture(t)
  assert.equal(await designer.installModels('background', async () => false), null)
  assert.deepEqual(designer.snapshot().config, config)
  assert.equal(designer.snapshot().modelDownload, undefined)
  for (const id of ['__proto__', '../arbitrary', 'constructor', { url: 'https://example.com' }]) {
    // Simulate malformed IPC input, which must be checked at runtime.
    await assert.rejects(designer.installModels(id as never, async () => true), /Unknown/)
  }
  await assert.rejects(designer.installModels('sdxl', async () => true), /profile changed/)
  assert.equal(calls.length, 0)
  assert.equal(isLocked(), false)
})

test('files invisible to the running ComfyUI do not get selected or reported as ready', async t => {
  const { config, designer, ready, calls } = await designerFixture(t)
  designer.readiness = async () => ({ ...ready, backgroundModels: [] })
  await assert.rejects(designer.installModels('background', async () => true), /Files downloaded, but ComfyUI cannot see/)
  assert.equal(calls.length, 1)
  assert.deepEqual(designer.snapshot().config, config)
  assert.equal(designer.snapshot().modelDownload?.status, 'failed')
})

test('a later failed file leaves all model selections unchanged and releases the slot', async t => {
  const { root, config, designer, calls, isLocked } = await designerFixture(t, 2)
  await assert.rejects(designer.installModels('edit', async () => true), /Transfer interrupted/)
  assert.equal(calls.length, 2)
  assert.deepEqual(designer.snapshot().config, config)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'designer.json'), 'utf8')).config, config)
  assert.equal(designer.snapshot().modelDownload?.status, 'failed')
  assert.equal(isLocked(), false)
})

test('older saved BiRefNet errors gain the action without rerunning or rewriting their output', async t => {
  const { root, config } = await designerFixture(t)
  await writeFile(join(root, 'designer.json'), JSON.stringify({ config, references: [], designs: [{
    id: 'legacy', title: 'Legacy failure', request, config, status: 'failed', stage: 'tpose', createdAt: '2026-01-01',
    message: 'Install a native BiRefNet background-removal checkpoint in ComfyUI models\\background_removal, refresh, and select it. A prompt-only background is not safe for 3D generation.'
  }] }))
  const restored = new Designer(root, root, new Map(), () => { throw new Error('No backend access needed') }, () => () => {}, () => {}, async () => Buffer.alloc(0))
  assert.deepEqual(restored.snapshot().designs[0].recovery, { package: 'background' })
  assert.equal(restored.snapshot().designs[0].status, 'failed')
  assert.equal(restored.snapshot().designs[0].tposeUrl, undefined)
})

test('existing compatible selections are skipped, including unquantized FLUX and custom scene weights', async t => {
  const { config, ready } = await designerFixture(t)
  const unquantized = 'custom\\flux-2-klein-4b.safetensors'
  ready.diffusionModels = [unquantized]
  config.editModel = unquantized
  assert.equal(needsDesignerModel(designerModelPackages.edit.models[0], config, ready), false)
  assert.equal(needsDesignerModel(designerModelPackages.sd15.models[0], config, ready), false)
  config.editModel = 'unrelated-model.safetensors'
  ready.diffusionModels.push(config.editModel)
  assert.equal(needsDesignerModel(designerModelPackages.edit.models[0], config, ready), true)
})

test('cancelling setup releases the shared slot and preserves choices', async t => {
  const { config, designer, calls, isLocked } = await designerFixture(t)
  let allow!: () => void
  const approval = new Promise<void>(resolve => { allow = resolve })
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const install = designer.installModels('background', async () => { entered(); await approval; return true })
  await waiting
  const cancelled = designer.cancelDownload()
  const failure = assert.rejects(install, /cancelled/)
  allow()
  await Promise.all([cancelled, failure])
  assert.equal(isLocked(), false)
  assert.equal(calls.length, 0)
  assert.deepEqual(designer.snapshot().config, config)
  assert.equal(designer.snapshot().modelDownload?.status, 'cancelled')
})
