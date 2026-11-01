import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Studio } from '../src/main/studio'
import { designConfigSchema, designRequestSchema, checkDesignBudget, designOutputPath, runDesignWorkflow } from '../src/main/designer'
import { imageWorkflow, meshWorkflow } from '../src/main/design-workflows'
import type { DesignerConfig, DesignRequest, DesignerReadiness } from '../src/shared/designer'
import { validateCutout } from '../src/main/image-validation'

const config: DesignerConfig = { imageProfile: 'sd15', checkpoint: 'DreamShaper_8.safetensors', controlnet: 'control_sd15_openpose.safetensors', meshProfile: 'mini', meshCheckpoint: 'hunyuan3d-dit-v2-mini.safetensors', titleModel: '', backgroundModel: 'birefnet.safetensors' }
const request: DesignRequest = { title: 'Jungle Champion', description: 'A Brazilian MMA fighter raised in the jungles of Brazil', style: 'A 90s video game character with vibrant colors and exaggerated upper-body muscles', seed: 42, steps: 20, referenceStrength: 0.3 }
const readiness: DesignerReadiness = { devices: [{ name: 'Test GPU', freeGB: 12, totalGB: 16 }], checkpoints: [config.checkpoint, config.meshCheckpoint], controlnets: [config.controlnet], titleModels: [], ipadapters: [], clipVision: [], backgroundModels: ['birefnet.safetensors'] }

test('scene workflow carries both descriptions and an optional actual image input', () => {
  const text = imageWorkflow(config, request, 'concept')
  assert.match(String(text['2'].inputs.text), /Brazil/)
  assert.match(String(text['2'].inputs.text), /90s video game/)
  assert.equal(text['4'].class_type, 'EmptyLatentImage')
  assert.equal(text['5'].inputs.seed, 42)
  assert.equal(text['5'].inputs.denoise, 1)
  const image = imageWorkflow(config, request, 'concept', 'input.png')
  assert.equal(image['8'].inputs.image, 'input.png')
  assert.equal(image['4'].class_type, 'VAEEncode')
  assert.equal(image['5'].inputs.denoise, 0.7)
})

test('T-pose workflow consumes the completed scene and pose ControlNet, preserving model family', () => {
  const graph = imageWorkflow({ ...config, imageProfile: 'sdxl' }, request, 'pose', 'scene.png', 'pose-map.png')
  assert.equal(graph['9'].inputs.width, 1024)
  assert.equal(graph['8'].inputs.image, 'scene.png')
  assert.equal(graph['10'].inputs.image, 'pose-map.png')
  assert.equal(graph['11'].inputs.control_net_name, config.controlnet)
  assert.deepEqual(graph['5'].inputs.positive, ['12', 0])
  assert.deepEqual(graph['5'].inputs.negative, ['12', 1])
  assert.match(String(graph['2'].inputs.text), /plain pure white background/)
  assert.match(String(graph['2'].inputs.text), /straight horizontal arms/)
  assert.equal(graph['16'].class_type, 'LoadBackgroundRemovalModel')
  assert.equal(graph['17'].class_type, 'RemoveBackground')
  assert.equal(graph['18'].class_type, 'InvertMask')
  assert.deepEqual(graph['19'].inputs.alpha, ['18', 0])
  assert.deepEqual(graph['7'].inputs.images, ['19', 0])
  assert.throws(() => imageWorkflow({ ...config, backgroundModel: '' }, request, 'pose', 'scene.png', 'pose.png'), /background-removal weights/)
})

test('identity adapter consumes the actual reference without reusing its scene latent', () => {
  const graph = imageWorkflow({ ...config, ipadapter: 'plus_sd15.safetensors', clipVision: 'vision.safetensors' }, request, 'pose', 'scene.png', 'pose-map.png')
  assert.equal(graph['4'].class_type, 'EmptyLatentImage')
  assert.equal(graph['5'].inputs.denoise, 1)
  assert.deepEqual(graph['5'].inputs.model, ['15', 0])
  assert.deepEqual(graph['15'].inputs.image, ['9', 0])
  assert.equal(graph['8'].inputs.image, 'scene.png')
  assert.equal(graph['15'].inputs.weight, 0.6)
})

test('3D workflow uses native single-image geometry nodes, flow sampling and bounded profiles', () => {
  for (const meshProfile of ['mini', 'standard'] as const) {
    const graph = meshWorkflow({ ...config, meshProfile }, request, 'mesh', 'tpose.png')
    assert.equal(graph['2'].inputs.image, 'tpose.png')
    assert.equal(graph['3'].inputs.crop, 'none')
    assert.deepEqual(graph['3'].inputs.image, ['13', 0])
    assert.deepEqual(graph['11'].inputs.mask, ['2', 1])
    assert.equal(graph['12'].inputs.color, 0xffffff)
    assert.deepEqual(graph['13'].inputs.mask, ['11', 0])
    assert.deepEqual(graph['6'].inputs.model, ['10', 0])
    assert.equal(graph['10'].class_type, 'ModelSamplingAuraFlow')
    assert.equal(graph['10'].inputs.shift, 1)
    assert.equal(graph['7'].inputs.octree_resolution, meshProfile === 'mini' ? 128 : 256)
    assert.equal(graph['9'].class_type, 'SaveGLB')
    assert.ok(Object.values(graph).every(node => !/Api|Tripo|Download/i.test(node.class_type)))
  }
})

test('cutout validation rejects opaque backgrounds, empty masks and cropped foreground', () => {
  const bitmap = new Uint8Array(100 * 100 * 4)
  assert.throws(() => validateCutout(bitmap, 100, 100), /usable transparent/)
  for (let y = 15; y < 85; y++) for (let x = 35; x < 65; x++) bitmap[(y * 100 + x) * 4 + 3] = 255
  assert.doesNotThrow(() => validateCutout(bitmap, 100, 100))
  bitmap[3] = 255
  assert.throws(() => validateCutout(bitmap, 100, 100), /touches the image border/)
  bitmap.fill(255)
  assert.throws(() => validateCutout(bitmap, 100, 100), /touches the image border/)
})

test('design IPC schemas reject invalid values, arbitrary keys and missing descriptions', () => {
  assert.deepEqual(designRequestSchema.parse(request), request)
  assert.throws(() => designRequestSchema.parse({ ...request, description: '' }))
  assert.throws(() => designRequestSchema.parse({ ...request, style: '' }))
  assert.throws(() => designRequestSchema.parse({ ...request, referenceId: '..\\secret' }))
  assert.throws(() => designRequestSchema.parse({ ...request, seed: -1 }))
  assert.throws(() => designRequestSchema.parse({ ...request, referenceStrength: 0.99 }))
  assert.throws(() => designConfigSchema.parse({ ...config, inferenceUrl: 'https://example.com' }))
})

test('VRAM budgets use free memory on one GPU, not aggregate or total capacity', () => {
  assert.doesNotThrow(() => checkDesignBudget(readiness, 12))
  assert.throws(() => checkDesignBudget(readiness, 12.01), /available GPU memory/)
  assert.throws(() => checkDesignBudget({ ...readiness, devices: [] }, 4))
  assert.throws(() => checkDesignBudget({ ...readiness, devices: [{ name: 'one', freeGB: 3, totalGB: 48 }, { name: 'two', freeGB: 3, totalGB: 48 }] }, 4))
})

test('output paths reject traversal, external files, wrong type and wrong extension', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kimodo-design-paths-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'output'))
  await writeFile(join(root, 'output', 'image.png'), 'fixture')
  await writeFile(join(root, 'private.png'), 'fixture')
  const item = { filename: 'image.png', subfolder: '', type: 'output' }
  assert.equal(await designOutputPath(join(root, 'output'), item, '.png'), await realpath(join(root, 'output', 'image.png')))
  await assert.rejects(designOutputPath(join(root, 'output'), { ...item, filename: 'private.png', subfolder: '..' }, '.png'), /outside/)
  await assert.rejects(designOutputPath(join(root, 'output'), { ...item, filename: '..\\private.png' }, '.png'))
  await assert.rejects(designOutputPath(join(root, 'output'), { ...item, type: 'input' }, '.png'))
  await assert.rejects(designOutputPath(join(root, 'output'), item, '.glb'))
})

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'kimodo-designer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'comfy-output')
  await mkdir(output)
  await writeFile(join(output, 'image.png'), 'TEST-ONLY image bytes')
  let promptId = '', cancelled = '', pending = false, failed = false, missingOutput = false
  let filename = ''
  const submissions: Record<string, unknown>[] = []
  const catalog = Object.fromEntries([
    ...Object.values(imageWorkflow(config, request, 'test')),
    ...Object.values(imageWorkflow(config, request, 'test', 'ref.png', 'pose.png'))
  ].map(n => [n.class_type, { input: {} }]))
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/object_info') { res.end(JSON.stringify(catalog)); return }
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.url === '/prompt') {
      const body = JSON.parse(raw)
      promptId = body.prompt_id; submissions.push(body)
      filename = body.prompt['7'].inputs.filename_prefix + '_00001_.png'
      await copyFile(join(output, 'image.png'), join(output, filename))
      res.end(JSON.stringify({ prompt_id: promptId }))
    } else if (req.url === `/history/${promptId}`) {
      res.end(JSON.stringify(pending ? {} : { [promptId]: { status: { completed: !failed, status_str: failed ? 'error' : 'success', messages: failed ? [['execution_error', { node_type: 'KSampler', exception_message: 'Test GPU OOM' }]] : [] }, outputs: missingOutput ? {} : { '7': { images: [{ filename, subfolder: '', type: 'output' }] } } } }))
    } else if (req.url === `/api/jobs/${promptId}/cancel`) { cancelled = promptId; res.end('{}') }
    else { res.statusCode = 404; res.end('{}') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const studio = new Studio(root, resolve('.'), async () => Buffer.from('decoded TEST-ONLY image'))
  studio.saveSettings({ ...studio.snapshot().settings, comfyUrl: base, comfyOutput: output })
  studio.designer.saveSettings(config)
  studio.designer.readiness = async () => readiness
  return { root, base, studio, submissions, catalog, cancelled: () => cancelled, promptId: () => promptId,
    setPending: () => { pending = true }, setFailed: () => { failed = true }, setMissing: () => { missingOutput = true } }
}

test('completed stages, briefs and settings persist without overwriting completed results', async t => {
  const { root, studio, submissions } = await fixture(t)
  const id = studio.designer.create(request)
  await studio.designer.run(id, 'scene')
  assert.equal(submissions.length, 1)
  const design = studio.snapshot().designer!.designs[0]
  assert.equal(design.title, request.title)
  assert.ok(design.sceneUrl)
  assert.equal(design.modelUrl, undefined)
  assert.equal(design.status, 'idle')
  studio.designer.saveSettings({ ...config, checkpoint: 'different.safetensors' })
  assert.equal(studio.designer.snapshot().designs[0].config.checkpoint, config.checkpoint)
  await assert.rejects(studio.designer.run(id, 'scene'), /already complete/)
  await assert.rejects(studio.designer.run(id, 'model'), /preceding/)
  assert.throws(() => studio.designer.output(id, 'model'), /no completed output/)
  const restarted = new Studio(root, resolve('.')).snapshot().designer!
  assert.equal(restarted.designs[0].sceneUrl, design.sceneUrl)
  assert.deepEqual(restarted.designs[0].request, request)
  const workflow = JSON.parse(await readFile(join(root, 'designs', id, 'scene-workflow.json'), 'utf8'))
  assert.equal(workflow.title, request.title)
})

test('failed and missing output jobs never expose completed assets', async t => {
  const { studio, setFailed, cancelled } = await fixture(t)
  setFailed()
  const id = studio.designer.create(request)
  await assert.rejects(studio.designer.run(id, 'scene'), /Test GPU OOM/)
  const design = studio.designer.snapshot().designs[0]
  assert.equal(design.status, 'failed')
  assert.equal(design.sceneUrl, undefined)
  assert.equal(cancelled(), design.promptId)
})

test('completed history without required image data is an actionable failure', async t => {
  const { studio, setMissing } = await fixture(t)
  setMissing()
  await assert.rejects(studio.designer.run(studio.designer.create(request), 'scene'), /required images output/)
  assert.equal(studio.designer.snapshot().designs[0].sceneUrl, undefined)
})

test('missing local models and untitled designs without naming models block before submission', async t => {
  const { studio, submissions } = await fixture(t)
  const untitled = studio.designer.create({ ...request, title: '' })
  await assert.rejects(studio.designer.run(untitled, 'scene'), /already-installed local Ollama/)
  studio.designer.saveSettings({ ...config, checkpoint: 'not-installed' })
  const missing = studio.designer.create(request)
  await assert.rejects(studio.designer.run(missing, 'scene'), /installed checkpoint/)
  assert.equal(submissions.length, 0)
})

test('automatic naming uses a local CPU model, preserves given titles and rejects cloud-backed models', async t => {
  const { studio } = await fixture(t)
  const fetch = globalThis.fetch
  const calls: { path: string; body: Record<string, unknown> }[] = []
  let remote = false
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('http://127.0.0.1:11434/')) return fetch(input, init)
    const path = new URL(url).pathname
    const body = JSON.parse(String(init?.body))
    calls.push({ path, body })
    return Response.json(path === '/api/show' ? remote ? { remote_host: 'https://example.com', remote_model: 'cloud' } : {} :
      { response: '{"title":"Emerald Guardian"}', done: true })
  })
  studio.designer.saveSettings({ ...config, titleModel: 'test-local-model' })
  studio.designer.readiness = async () => ({ ...readiness, titleModels: ['test-local-model'] })
  const id = studio.designer.create({ ...request, title: '' })
  await studio.designer.run(id, 'scene')
  assert.equal(studio.designer.title(id), 'Emerald Guardian')
  const generation = calls.find(call => call.path === '/api/generate')!
  assert.deepEqual(generation.body.options, { num_gpu: 0, num_ctx: 2048, num_predict: 80, seed: 42 })
  assert.equal(generation.body.keep_alive, 0)
  await studio.designer.run(studio.designer.create(request), 'scene')
  assert.equal(calls.length, 2, 'Provided titles must not invoke naming.')
  remote = true
  await assert.rejects(studio.designer.run(studio.designer.create({ ...request, title: '' }), 'scene'), /remote inference/)
  assert.equal(calls.filter(call => call.path === '/api/generate').length, 1)
})

test('cancellation is prompt-scoped and designer locks Animator and shared settings', async t => {
  const { studio, setPending, promptId, cancelled } = await fixture(t)
  setPending()
  const id = studio.designer.create(request)
  const work = studio.designer.run(id, 'scene')
  const rejected = assert.rejects(work, /cancelled/)
  assert.throws(() => studio.saveSettings(studio.snapshot().settings), /current operation/)
  assert.throws(() => studio.designer.create(request), /share one local job slot/)
  await assert.rejects(studio.importDesign(id), /no completed output/)
  const deadline = Date.now() + 5000
  while (!promptId() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(promptId(), 'Prompt must have reached the backend before cancellation.')
  await studio.designer.cancel()
  await rejected
  assert.equal(cancelled(), promptId())
  assert.equal(studio.designer.snapshot().designs[0].status, 'cancelled')
  assert.equal(studio.designer.snapshot().designs[0].sceneUrl, undefined)
  assert.doesNotThrow(() => studio.saveSettings(studio.snapshot().settings))
})

test('restart marks an interrupted stage failed and preserves completed earlier stages', async t => {
  const { root, studio } = await fixture(t)
  const id = studio.designer.create(request)
  await studio.designer.run(id, 'scene')
  const state = studio.designer.snapshot()
  state.designs[0].status = 'running'; state.designs[0].stage = 'tpose'; state.designs[0].promptId = 'interrupted-test'
  await writeFile(join(root, 'designer.json'), JSON.stringify(state))
  const design = new Studio(root, resolve('.')).designer.snapshot().designs[0]
  assert.equal(design.status, 'failed')
  assert.match(design.message, /interrupted-test/)
  assert.ok(design.sceneUrl)
  assert.equal(design.tposeUrl, undefined)
})

test('legacy non-isolated T-poses cannot be submitted to the 3D model', async t => {
  const { root, studio } = await fixture(t)
  const id = studio.designer.create(request)
  const state = studio.designer.snapshot()
  state.designs[0].sceneUrl = 'old-scene'
  state.designs[0].tposeUrl = 'old-opaque-pose'
  await writeFile(join(root, 'designer.json'), JSON.stringify(state))
  const restarted = new Studio(root, resolve('.'))
  await assert.rejects(restarted.designer.run(id, 'model'), /isolated transparent T-pose/)
})

test('remote ComfyUI URLs are rejected by the workflow executor', async () => {
  await assert.rejects(runDesignWorkflow('https://example.com', {}, '7', 'images', new AbortController().signal, () => {}, () => {}), /local ComfyUI URL/)
})
