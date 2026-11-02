import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { crc32, deflateSync } from 'node:zlib'
import { Studio } from '../src/main/studio'
import { designConfigSchema, designRequestSchema, designImportSchema, checkDesignBudget, designOutputPath, runDesignWorkflow } from '../src/main/designer'
import { imageWorkflow, meshWorkflow, tposeWorkflow, type Workflow } from '../src/main/design-workflows'
import type { DesignerConfig, DesignRequest, DesignerReadiness } from '../src/shared/designer'
import type { Character } from '../src/shared/types'
import { handAnatomyPrompt, meshTextureProfile, specifiesHandAnatomy, tposeEditPrompt } from '../src/shared/designer'
import { validateCutout } from '../src/main/image-validation'

const config: DesignerConfig = { imageProfile: 'sd15', checkpoint: 'DreamShaper_8.safetensors', controlnet: 'control_sd15_openpose.safetensors', meshProfile: 'mini', meshCheckpoint: 'hunyuan3d-dit-v2-mini.safetensors', titleModel: '', backgroundModel: 'birefnet.safetensors', editModel: 'flux-2-klein-4b-fp8.safetensors', editTextEncoder: 'qwen_3_4b.safetensors', editVae: 'flux2-vae.safetensors' }
const request: DesignRequest = { title: 'Jungle Champion', description: 'A Brazilian MMA fighter raised in the jungles of Brazil', style: 'A 90s video game character with vibrant colors and exaggerated upper-body muscles', seed: 42, steps: 20, referenceStrength: 0.3 }
const readiness: DesignerReadiness = { devices: [{ name: 'Test GPU', freeGB: 12, totalGB: 16 }], checkpoints: [config.checkpoint, config.meshCheckpoint], controlnets: [config.controlnet], titleModels: [], ipadapters: [], clipVision: [meshTextureProfile.vision], backgroundModels: ['birefnet.safetensors'], diffusionModels: [config.editModel!, meshTextureProfile.model], textEncoders: [config.editTextEncoder!], vaes: [config.editVae!, meshTextureProfile.shapeVae, meshTextureProfile.textureVae] }

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

test('T-pose uses actual scene latents and an edit-only instruction, never the character/style brief', () => {
  const graph = tposeWorkflow(config, request, 'pose', 'scene.png')
  assert.equal(graph['4'].inputs.image, 'scene.png')
  assert.deepEqual(graph['6'].inputs.pixels, ['5', 0])
  assert.deepEqual(graph['10'].inputs.latent, ['6', 0])
  assert.deepEqual(graph['11'].inputs.latent, ['6', 0])
  assert.deepEqual(graph['12'].inputs.positive, ['10', 0])
  assert.deepEqual(graph['12'].inputs.negative, ['11', 0])
  assert.equal(graph['8'].inputs.text, `${tposeEditPrompt} ${handAnatomyPrompt}`)
  assert.match(tposeEditPrompt, /^Put this character in a T-pose, remove the background, only show the character\./)
  assert.match(String(graph['8'].inputs.text), /Both hands flat with palms facing down, fingers straight and held together side by side/)
  assert.match(String(graph['8'].inputs.text), /thumbs resting naturally alongside/)
  assert.match(String(graph['8'].inputs.text), /No splayed or curled fingers and no fists/)
  assert.equal(JSON.stringify(graph).includes(request.description), false)
  assert.equal(JSON.stringify(graph).includes(request.style), false)
  assert.equal(graph['14'].inputs.steps, 4)
  assert.equal(graph['12'].inputs.cfg, 1)
  assert.equal(graph['2'].inputs.type, 'flux2')
  assert.equal(graph['21'].inputs.noise_seed, request.seed)
  assert.ok(Object.values(graph).every(node => !/ControlNet|IPAdapter|CheckpointLoaderSimple/.test(node.class_type)))
  assert.equal(graph['16'].class_type, 'LoadBackgroundRemovalModel')
  assert.equal(graph['17'].class_type, 'RemoveBackground')
  assert.equal(graph['18'].class_type, 'InvertMask')
  assert.deepEqual(graph['19'].inputs.alpha, ['18', 0])
  assert.deepEqual(graph['7'].inputs.images, ['19', 0])
  assert.throws(() => tposeWorkflow({ ...config, backgroundModel: '' }, request, 'pose', 'scene.png'), /background-removal weights/)
  assert.throws(() => tposeWorkflow({ ...config, editModel: '' }, request, 'pose', 'scene.png'), /editing requires/)
})

test('hidden five-finger default applies unless the brief specifies hand anatomy', () => {
  const scene = imageWorkflow(config, request, 'concept')
  assert.ok(String(scene['2'].inputs.text).endsWith(handAnatomyPrompt))
  assert.match(String(scene['3'].inputs.text), /extra fingers, missing fingers, fused fingers, six fingers/)
  const clawed = { ...request, description: 'A lizard warrior with three clawed fingers on each hand' }
  assert.equal(specifiesHandAnatomy(clawed), true)
  assert.equal(specifiesHandAnatomy({ description: 'Wears fingerless gloves and carries a sword', style: 'Hand-painted' }), false)
  const custom = imageWorkflow(config, clawed, 'concept')
  assert.equal(String(custom['2'].inputs.text).includes(handAnatomyPrompt), false)
  assert.doesNotMatch(String(custom['3'].inputs.text), /fingers/)
  assert.equal(tposeWorkflow(config, clawed, 'pose', 'scene.png')['8'].inputs.text, tposeEditPrompt)
})

test('identity adapter consumes the actual reference without reusing its scene latent', () => {
  const graph = imageWorkflow({ ...config, ipadapter: 'plus_sd15.safetensors', clipVision: 'vision.safetensors' }, request, 'scene', 'reference.png')
  assert.equal(graph['4'].class_type, 'EmptyLatentImage')
  assert.equal(graph['5'].inputs.denoise, 1)
  assert.deepEqual(graph['5'].inputs.model, ['15', 0])
  assert.deepEqual(graph['15'].inputs.image, ['9', 0])
  assert.equal(graph['8'].inputs.image, 'reference.png')
  assert.equal(graph['9'].inputs.crop, 'center')
  assert.match(String(graph['3'].inputs.text), /crowd, extra people/)
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

test('textured generation conditions on foreground and shares shape, UV mesh and texture maps', () => {
  const graph = meshWorkflow(designConfigSchema.parse({ ...config, meshProfile: 'textured' }), request, 'textured', 'pose.png')
  assert.equal(graph['2'].inputs.image, 'pose.png')
  assert.deepEqual(graph['6'].inputs.mask, ['2', 1])
  assert.deepEqual(graph['7'].inputs.masks, ['6', 0])
  assert.equal(graph['7'].inputs.background, '#000000')
  assert.equal(graph['7'].inputs.pad_factor, 1)
  assert.deepEqual(graph['21'].inputs.shape_latent, ['19', 0])
  assert.deepEqual(graph['23'].inputs.shape_subdivides, ['20', 1])
  assert.equal(graph['25'].class_type, 'UnwrapMesh')
  assert.deepEqual(graph['26'].inputs.mesh, graph['27'].inputs.mesh)
  assert.deepEqual(graph['27'].inputs.base_color, ['26', 0])
  assert.deepEqual(graph['27'].inputs.metallic, ['26', 1])
  assert.deepEqual(graph['27'].inputs.roughness, ['26', 2])
  assert.equal(graph['26'].inputs.texture_size, 1024)
  assert.equal(graph['24'].inputs.target_face_count, 50000)
  assert.deepEqual(graph['24'].inputs.mesh, ['29', 0])
  assert.equal(graph['29'].class_type, 'RemeshMesh')
  assert.deepEqual(graph['29'].inputs.mesh, ['20', 0])
  assert.equal(graph['29'].inputs.sign_mode, 'solid')
  assert.equal(graph['29'].inputs.resolution, 512)
  assert.deepEqual(graph['9'].inputs.mesh, ['28', 0])
  assert.equal(graph['30'], undefined)
  assert.deepEqual(graph['20'].inputs.samples, ['19', 0])
  assert.ok(Object.values(graph).every(node => !/Api|Hunyuan|Download/.test(node.class_type)))
})

test('textured quality settings add a shape refinement pass and size the remesh, faces and atlas', () => {
  const graph = meshWorkflow(designConfigSchema.parse({ ...config, meshProfile: 'textured', meshShapeDetail: 1536, meshTextureSize: 4096, meshFaceCount: 150000 }), request, 'textured', 'pose.png')
  assert.equal(graph['30'].class_type, 'Trellis2UpsampleStage')
  assert.deepEqual(graph['30'].inputs.shape_latent, ['19', 0])
  assert.deepEqual(graph['30'].inputs.vae, ['4', 0])
  assert.equal(graph['30'].inputs.target_resolution, 1536)
  assert.deepEqual(graph['31'].inputs.latent_image, ['30', 2])
  assert.equal(graph['31'].inputs.seed, request.seed)
  assert.deepEqual(graph['20'].inputs.samples, ['31', 0])
  assert.deepEqual(graph['21'].inputs, { positive: ['30', 0], negative: ['30', 1], shape_latent: ['31', 0] })
  assert.equal(graph['29'].inputs.resolution, 768)
  assert.equal(graph['24'].inputs.target_face_count, 150000)
  assert.equal(graph['25'].inputs.resolution, 4096)
  assert.equal(graph['26'].inputs.texture_size, 4096)
  const high = meshWorkflow(designConfigSchema.parse({ ...config, meshProfile: 'textured', meshShapeDetail: 1024 }), request, 'textured', 'pose.png')
  assert.equal(high['30'].inputs.target_resolution, 1024)
  assert.equal(high['29'].inputs.resolution, 512)
  assert.equal(high['26'].inputs.texture_size, 1024)
  for (const invalid of [{ meshShapeDetail: 768 }, { meshTextureSize: 3000 }, { meshFaceCount: 5000 }, { meshFaceCount: 600000 }, { meshFaceCount: 50000.5 }])
    assert.throws(() => designConfigSchema.parse({ ...config, ...invalid }))
})

test('design IPC schemas reject invalid values, arbitrary keys and missing descriptions', () => {
  assert.deepEqual(designRequestSchema.parse(request), request)
  assert.throws(() => designRequestSchema.parse({ ...request, description: '' }))
  assert.throws(() => designRequestSchema.parse({ ...request, style: '' }))
  assert.throws(() => designRequestSchema.parse({ ...request, referenceId: '..\\secret' }))
  assert.throws(() => designRequestSchema.parse({ ...request, seed: -1 }))
  assert.throws(() => designRequestSchema.parse({ ...request, referenceStrength: 0.99 }))
  assert.throws(() => designConfigSchema.parse({ ...config, inferenceUrl: 'https://example.com' }))
  const migrated = designConfigSchema.parse({ ...config, editModel: undefined, editTextEncoder: undefined, editVae: undefined })
  assert.equal(migrated.editModel, 'flux-2-klein-4b-fp8.safetensors')
  assert.equal(migrated.editTextEncoder, 'qwen_3_4b.safetensors')
  assert.equal(designConfigSchema.parse({ ...config, editModel: '' }).editModel, '')
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
  let promptId = '', cancelled = '', pending = false, failed = false, missingOutput = false, textured = false, atlasSize = 1024
  let filename = ''
  const submissions: Record<string, unknown>[] = []
  const uploads: { name: string; body: string }[] = []
  const decoded: { file: string; cutout?: boolean; squareSize?: number }[] = []
  const catalog = Object.fromEntries([
    ...Object.values(imageWorkflow(config, request, 'test')),
    ...Object.values(tposeWorkflow(config, request, 'test', 'ref.png')),
    ...Object.values(meshWorkflow(config, request, 'test', 'pose.png')),
    ...Object.values(meshWorkflow(designConfigSchema.parse({ ...config, meshProfile: 'textured' }), request, 'test', 'pose.png')),
    ...Object.values(meshWorkflow(designConfigSchema.parse({ ...config, meshProfile: 'textured', meshShapeDetail: 1024 }), request, 'test', 'pose.png'))
  ].map(n => [n.class_type, { input: {} }]))
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/object_info') { res.end(JSON.stringify(catalog)); return }
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.url === '/prompt') {
      const body = JSON.parse(raw)
      promptId = body.prompt_id; submissions.push(body)
      const model = !!body.prompt['9'] && body.prompt['9'].class_type === 'SaveGLB'
      filename = body.prompt[model ? '9' : '7'].inputs.filename_prefix + (model ? '_00001_.glb' : '_00001_.png')
      if (model) await writeFile(join(output, filename), meshFixture(textured, atlasSize))
      else await copyFile(join(output, 'image.png'), join(output, filename))
      res.end(JSON.stringify({ prompt_id: promptId }))
    } else if (req.url === `/history/${promptId}`) {
      const model = filename.endsWith('.glb')
      res.end(JSON.stringify(pending ? {} : { [promptId]: { status: { completed: !failed, status_str: failed ? 'error' : 'success', messages: failed ? [['execution_error', { node_type: 'KSampler', exception_message: 'Test GPU OOM' }]] : [] }, outputs: missingOutput ? {} : { [model ? '9' : '7']: { [model ? '3d' : 'images']: [{ filename, subfolder: '', type: 'output' }] } } } }))
    } else if (req.url === '/upload/image') {
      const name = /filename="([^"]+)"/.exec(raw)?.[1]
      assert.ok(name)
      uploads.push({ name, body: raw })
      res.end(JSON.stringify({ name, subfolder: '', type: 'input' }))
    } else if (req.url === `/api/jobs/${promptId}/cancel`) { cancelled = promptId; res.end('{}') }
    else { res.statusCode = 404; res.end('{}') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const studio = new Studio(root, resolve('.'), async (file, cutout, squareSize) => {
    decoded.push({ file, cutout, squareSize })
    return Buffer.from(squareSize ? 'square-padded TEST-ONLY image' : 'decoded TEST-ONLY image')
  })
  studio.saveSettings({ ...studio.snapshot().settings, comfyUrl: base, comfyOutput: output, comfyRoot: root })
  studio.designer.saveSettings(config)
  studio.designer.readiness = async () => ({ ...readiness, devices: [{ name: 'Test GPU', freeGB: 24, totalGB: 32 }] })
  return { root, base, studio, submissions, catalog, uploads, decoded, cancelled: () => cancelled, promptId: () => promptId,
    setPending: () => { pending = true }, setFailed: () => { failed = true }, setMissing: () => { missingOutput = true },
    setTextured: (size = 1024) => { textured = true; atlasSize = size } }
}

function meshFixture(textured = false, size = 1024): Buffer {
  const pngChunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12)
    bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8)
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4)
    return bytes
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2
  const png = textured ? Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc(size * (size * 3 + 1)))), pngChunk('IEND', Buffer.alloc(0))]) : Buffer.alloc(0)
  const binaryLength = textured ? Math.ceil((60 + png.length) / 4) * 4 : 36
  const json = JSON.stringify({
    asset: { version: '2.0' }, buffers: [{ byteLength: binaryLength }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, ...(textured ? [{ buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: png.length }] : [])],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, ...(textured ? [{ bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }] : [])],
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(textured ? { TEXCOORD_0: 1 } : {}) }, ...(textured ? { material: 0 } : {}) }] }],
    ...(textured ? { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 0 } } }],
      textures: [{ source: 0 }], images: [{ bufferView: 2, mimeType: 'image/png' }] } : {})
  })
  const chunk = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4))
  const bytes = Buffer.alloc(28 + chunk.length + binaryLength)
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(chunk.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); chunk.copy(bytes, 20)
  bytes.writeUInt32LE(binaryLength, 20 + chunk.length); bytes.writeUInt32LE(0x004e4942, 24 + chunk.length)
  if (textured) png.copy(bytes, 28 + chunk.length + 60)
  return bytes
}

test('completed textured models retain material metadata, provenance and bytes across restart and import', async t => {
  const { root, studio, setTextured } = await fixture(t)
  setTextured()
  studio.designer.saveSettings({ ...config, meshProfile: 'textured' })
  const file = join(root, 'pose.png')
  await writeFile(file, 'TEST-ONLY cutout')
  const id = await studio.designer.importStage(file, { stage: 'tpose', brief: request, isolated: true })
  await studio.designer.run(id, 'model')
  const generated = studio.designer.snapshot().designs[0]
  assert.equal(generated.status, 'idle')
  assert.equal(generated.modelTextured, true)
  assert.deepEqual(generated.sources?.model, { kind: 'generated', input: 'tpose' })
  assert.deepEqual(await readFile(studio.designer.output(id, 'model')), meshFixture(true))
  const restarted = new Studio(root, resolve('.')).designer
  assert.equal(restarted.snapshot().designs[0].modelTextured, true)
  assert.ok(restarted.snapshot().designs[0].modelUrl)
  await assert.rejects(restarted.run(id, 'model'), /already complete/)
  const imported = await restarted.importStage(restarted.output(id, 'model'), { stage: 'model', brief: request, isolated: false })
  assert.notEqual(imported, id)
  assert.equal(restarted.snapshot().designs[0].modelTextured, true)
  assert.equal(restarted.snapshot().designs[0].sources?.model?.kind, 'imported')
  assert.deepEqual(await readFile(restarted.output(imported, 'model')), meshFixture(true))
})

test('textured stages fail without matching weights or actual textures, preserving their T-pose', async t => {
  const { root, studio, submissions } = await fixture(t)
  const file = join(root, 'pose.png')
  await writeFile(file, 'TEST-ONLY cutout')
  const id = await studio.designer.importStage(file, { stage: 'tpose', brief: request, isolated: true })
  studio.designer.saveSettings({ ...config, meshProfile: 'textured', meshTextureModel: 'missing.safetensors' })
  await assert.rejects(studio.designer.run(id, 'model'), /Textured generation requires installed/)
  assert.equal(submissions.length, 0)
  studio.designer.saveSettings({ ...config, meshProfile: 'textured' })
  await assert.rejects(studio.designer.run(id, 'model'), /without base-color textures/)
  const design = studio.designer.snapshot().designs[0]
  assert.equal(design.status, 'failed')
  assert.equal(design.modelUrl, undefined)
  assert.equal(design.modelTextured, undefined)
  assert.ok(design.tposeUrl)
})

test('textured runs keep their quality settings, use a 1024 input and require the selected atlas size', async t => {
  const { root, studio, submissions, decoded, setTextured } = await fixture(t)
  const file = join(root, 'pose.png')
  await writeFile(file, 'TEST-ONLY cutout')
  const id = await studio.designer.importStage(file, { stage: 'tpose', brief: request, isolated: true })
  studio.designer.saveSettings({ ...config, meshProfile: 'textured', meshShapeDetail: 1024, meshTextureSize: 2048, meshFaceCount: 100000 })
  setTextured()
  await assert.rejects(studio.designer.run(id, 'model'), /2048x2048 PNG atlas/)
  assert.equal(decoded.at(-1)?.squareSize, 1024)
  const prompt = (submissions.at(-1) as { prompt: Workflow }).prompt
  assert.equal(prompt['30'].inputs.target_resolution, 1024)
  assert.equal(prompt['26'].inputs.texture_size, 2048)
  assert.equal(studio.designer.snapshot().designs[0].modelUrl, undefined)
  setTextured(2048)
  await studio.designer.run(id, 'model')
  const design = studio.designer.snapshot().designs[0]
  assert.equal(design.modelTextured, true)
  assert.deepEqual([design.config.meshShapeDetail, design.config.meshTextureSize, design.config.meshFaceCount], [1024, 2048, 100000])
  assert.match(design.message, /2K base-color/)
  studio.designer.saveSettings({ ...config, meshProfile: 'textured' })
  let required: number | undefined
  studio.importCharacter = async (_input, _name, size) => { required = size; return { id: 'test-character' } as Character }
  await studio.importDesign(id)
  assert.equal(required, 2048)
})

test('stage import schemas allow absent descriptions without weakening generated concept validation', () => {
  const brief = { ...request, title: '', description: '', style: '' }
  for (const stage of ['tpose', 'model']) assert.ok(designImportSchema.parse({ stage, brief, isolated: false }))
  assert.throws(() => designRequestSchema.parse(brief))
  assert.throws(() => designImportSchema.parse({ stage: 'model', brief, isolated: true }))
  assert.throws(() => designImportSchema.parse({ stage: 'invalid', brief, isolated: false }))
  assert.throws(() => designImportSchema.parse({ stage: 'tpose', brief, isolated: true, file: '..\\secret' }))
})

test('scenes are always generated from a brief, never imported as completed files', async t => {
  const { root, studio, submissions } = await fixture(t)
  const original = join(root, 'external-scene.png')
  await writeFile(original, 'external source image')
  assert.throws(() => designImportSchema.parse({ stage: 'scene', brief: request, isolated: false }))
  await assert.rejects(studio.designer.importStage(original, { stage: 'scene', brief: request, isolated: false } as never))
  assert.equal(studio.designer.snapshot().designs.length, 0)
  assert.equal(submissions.length, 0)
})

test('T-pose edits use the generated scene and current edit settings', async t => {
  const { root, studio, uploads } = await fixture(t)
  const id = studio.designer.create(request)
  await studio.designer.run(id, 'scene')
  const before = uploads.length
  await studio.designer.run(id, 'tpose')
  assert.equal(studio.designer.snapshot().designs[0].config.editModel, config.editModel)
  assert.ok(studio.designer.snapshot().designs[0].tposeUrl)
  const edit = JSON.parse(await readFile(join(root, 'designs', id, 'tpose-workflow.json'), 'utf8'))
  assert.equal(edit.workflow['4'].inputs.image, uploads[before].name)
  assert.ok(uploads[before].body.includes(await readFile(studio.designer.output(id, 'scene'), 'utf8')))
  assert.equal(edit.input.file, 'scene.png')
})

test('missing editing weights never silently fall back to an SD redraw', async t => {
  const { studio, submissions } = await fixture(t)
  const id = studio.designer.create(request)
  await studio.designer.run(id, 'scene')
  const before = submissions.length
  studio.designer.saveSettings({ ...config, editModel: '' })
  await assert.rejects(studio.designer.run(id, 'tpose'), /does not fall back/)
  assert.equal(submissions.length, before)
  assert.ok(studio.designer.snapshot().designs[0].sceneUrl)
  assert.equal(studio.designer.snapshot().designs[0].tposeUrl, undefined)
})

test('imported opaque T-pose skips scene and pose generation, then passes its actual cutout to 3D', async t => {
  const { root, studio, uploads, decoded } = await fixture(t)
  const file = join(root, 'external-pose.png')
  await writeFile(file, 'external opaque T-pose')
  studio.designer.saveSettings({ ...config, checkpoint: '', controlnet: '' })
  const id = await studio.designer.importStage(file, { stage: 'tpose', brief: { ...request, description: '', style: '' }, isolated: false })
  await assert.rejects(studio.designer.run(id, 'model'), /isolated transparent/)
  await studio.designer.run(id, 'tpose')
  const cleanup = JSON.parse(await readFile(join(root, 'designs', id, 'tpose-workflow.json'), 'utf8'))
  assert.ok(!Object.values(cleanup.workflow).some((node: unknown) => (node as { class_type: string }).class_type === 'KSampler'))
  assert.equal(cleanup.input.file, 'tpose.png')
  assert.equal(cleanup.workflow['1'].inputs.image, uploads[0].name)
  assert.ok(uploads[0].body.includes(await readFile(join(root, 'designs', id, 'tpose.png'), 'utf8')))
  await studio.designer.run(id, 'model')
  const model = JSON.parse(await readFile(join(root, 'designs', id, 'model-workflow.json'), 'utf8'))
  assert.equal(model.input.file, 'tpose-cutout.png')
  assert.equal(model.workflow['2'].inputs.image, uploads[1].name)
  assert.ok(uploads[1].body.includes(await readFile(join(root, 'designs', id, 'model-input.png'), 'utf8')))
  assert.ok(decoded.some(d => d.file.endsWith('tpose-cutout.png') && d.cutout && d.squareSize === 512))
  const design = studio.designer.snapshot().designs[0]
  assert.equal(design.sceneUrl, undefined)
  assert.ok(design.modelUrl)
  assert.equal(design.sources?.tpose?.kind, 'imported')
  assert.deepEqual(design.sources?.model, { kind: 'generated', input: 'tpose' })
  assert.equal(await readFile(join(root, 'designs', id, 'original-tpose.png'), 'utf8'), 'external opaque T-pose')
  await assert.rejects(studio.designer.run(id, 'scene'), /later stage/)
  await assert.rejects(studio.designer.run(id, 'model'), /already complete/)
})

test('transparent T-pose and embedded GLB imports bypass irrelevant generation prerequisites', async t => {
  const { root, studio, submissions, decoded } = await fixture(t)
  const image = join(root, 'cutout.png'), mesh = join(root, 'external.glb')
  await writeFile(image, 'TEST-ONLY transparent image')
  await writeFile(mesh, meshFixture())
  const blank = { ...request, title: '', description: '', style: '' }
  const pose = await studio.designer.importStage(image, { stage: 'tpose', brief: blank, isolated: true })
  assert.ok(decoded.some(d => d.file === join(root, 'designs', pose, 'original-tpose.png') && d.cutout))
  await studio.designer.run(pose, 'model')
  assert.equal(submissions.length, 1)
  const id = await studio.designer.importStage(mesh, { stage: 'model', brief: blank, isolated: false })
  assert.deepEqual(await readFile(studio.designer.output(id, 'model')), meshFixture())
  assert.equal(studio.designer.snapshot().designs[0].tposeUrl, undefined)
  assert.equal(submissions.length, 1)
  await writeFile(mesh, 'not a GLB')
  const count = studio.designer.snapshot().designs.length
  await assert.rejects(studio.designer.importStage(mesh, { stage: 'model', brief: blank, isolated: false }), /complete binary glTF/)
  assert.equal(studio.designer.snapshot().designs.length, count)
  const rejecting = new Studio(join(root, 'rejecting'), resolve('.'), async () => { throw new Error('Invalid cutout') })
  await assert.rejects(rejecting.designer.importStage(image, { stage: 'tpose', brief: blank, isolated: true }), /Invalid cutout/)
  assert.equal(rejecting.designer.snapshot().designs.length, 0)
})

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

test('completed stages can generate repeated variations with current briefs and models without overwriting outputs', async t => {
  const { root, studio } = await fixture(t)
  const id = studio.designer.create(request)
  for (const stage of ['scene', 'tpose', 'model'] as const) await studio.designer.run(id, stage)
  studio.designer.assign(id, 'original-animator-character')
  const original = studio.designer.snapshot().designs[0]
  const files = await Promise.all(['scene.png', 'tpose-cutout.png', 'model.glb', 'scene-workflow.json', 'tpose-workflow.json', 'model-workflow.json']
    .map(name => readFile(join(root, 'designs', id, name))))
  const updated = { ...request, description: 'A new robot in a city', style: 'Watercolor concept art', seed: 123, steps: 35 }
  studio.designer.saveSettings({ ...config, imageProfile: 'sdxl' })
  for (const stage of ['scene', 'tpose', 'model'] as const) {
    let source = id
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await studio.designer.variation(source, stage, updated)
      const prepared = studio.designer.snapshot().designs[0]
      assert.equal(prepared[`${stage}Url`], undefined)
      assert.equal(prepared.characterId, undefined)
      assert.equal(prepared.modelTextured, undefined)
      assert.equal(!!prepared.sceneUrl, stage !== 'scene')
      assert.equal(!!prepared.tposeUrl, stage === 'model')
      assert.equal(prepared.modelUrl, undefined)
      if (stage !== 'scene') {
        assert.deepEqual(await readFile(studio.designer.output(next, 'scene')), files[0])
        assert.deepEqual(await readFile(join(root, 'designs', next, 'scene-workflow.json')), files[3])
      }
      if (stage === 'model') {
        assert.deepEqual(await readFile(studio.designer.output(next, 'tpose')), files[1])
        assert.deepEqual(await readFile(join(root, 'designs', next, 'tpose-workflow.json')), files[4])
      }
      await studio.designer.run(next, stage)
      const workflow = JSON.parse(await readFile(join(root, 'designs', next, `${stage}-workflow.json`), 'utf8'))
      assert.deepEqual(workflow.request, updated)
      assert.equal(workflow.config.imageProfile, stage === 'scene' ? 'sdxl' : config.imageProfile)
      assert.equal(studio.designer.snapshot().designs[0].status, 'idle')
      source = next
    }
  }
  assert.deepEqual(studio.designer.snapshot().designs.find(d => d.id === id), original)
  assert.deepEqual(await Promise.all(['scene.png', 'tpose-cutout.png', 'model.glb', 'scene-workflow.json', 'tpose-workflow.json', 'model-workflow.json']
    .map(name => readFile(join(root, 'designs', id, name)))), files)
  const restarted = new Studio(root, resolve('.')).designer
  assert.equal(restarted.snapshot().designs.length, 7)
  assert.deepEqual(restarted.snapshot().designs.find(d => d.id === id)?.request, request)
})

test('a geometry variation can switch to textured generation while retaining its validated T-pose', async t => {
  const { root, studio, setTextured } = await fixture(t)
  const file = join(root, 'pose.png')
  await writeFile(file, 'TEST-ONLY cutout')
  const id = await studio.designer.importStage(file, { stage: 'tpose', brief: request, isolated: true })
  await studio.designer.run(id, 'model')
  studio.designer.saveSettings({ ...config, meshProfile: 'textured' })
  setTextured()
  const next = await studio.designer.variation(id, 'model', { ...request, seed: 84 })
  await studio.designer.run(next, 'model')
  const designs = studio.designer.snapshot().designs
  assert.equal(designs[0].modelTextured, true)
  assert.equal(designs[0].config.meshProfile, 'textured')
  assert.equal(designs[1].modelTextured, false)
  assert.equal(designs[1].config.meshProfile, 'mini')
  assert.equal(await readFile(join(root, 'designs', next, 'original-tpose.png'), 'utf8'), 'TEST-ONLY cutout')
  assert.deepEqual(designs[0].sources?.tpose, designs[1].sources?.tpose)
  await assert.rejects(studio.designer.variation(next, 'tpose', request), /preceding reference/)
})

test('failed and cancelled variations leave their source design and downstream outputs unchanged', async t => {
  const { studio, setFailed, setPending } = await fixture(t)
  const id = studio.designer.create(request)
  for (const stage of ['scene', 'tpose', 'model'] as const) await studio.designer.run(id, stage)
  const original = studio.designer.snapshot().designs[0]
  const failed = await studio.designer.variation(id, 'tpose', request)
  setFailed()
  await assert.rejects(studio.designer.run(failed, 'tpose'), /Test GPU OOM/)
  assert.equal(studio.designer.snapshot().designs[0].tposeUrl, undefined)
  const cancelled = await studio.designer.variation(id, 'model', request)
  setPending()
  const work = studio.designer.run(cancelled, 'model')
  const rejected = assert.rejects(work, /cancelled/)
  await assert.rejects(studio.designer.variation(id, 'scene', request), /share one local job slot/)
  await studio.designer.cancel()
  await rejected
  const designs = studio.designer.snapshot().designs
  assert.equal(designs[0].modelUrl, undefined)
  assert.equal(designs[0].status, 'cancelled')
  assert.deepEqual(designs.find(d => d.id === id), original)
})

test('variation requests enforce stage, brief, reference and cutout validation before creating designs', async t => {
  const { root, studio } = await fixture(t)
  const file = join(root, 'opaque.png')
  await writeFile(file, 'TEST-ONLY opaque pose')
  const id = await studio.designer.importStage(file, { stage: 'tpose', brief: request, isolated: false })
  await assert.rejects(studio.designer.variation(id, 'model', request), /isolated transparent/)
  await assert.rejects(studio.designer.variation(id, 'scene', { ...request, description: '' }))
  await assert.rejects(studio.designer.variation(id, 'scene', { ...request, referenceId: '00000000-0000-4000-8000-000000000001' }), /no longer exists/)
  await assert.rejects(studio.designer.variation(id, 'invalid' as never, request))
  assert.equal(studio.designer.snapshot().designs.length, 1)
  const cleanup = await studio.designer.variation(id, 'tpose', { ...request, seed: 99 })
  await studio.designer.run(cleanup, 'tpose')
  assert.equal(studio.designer.snapshot().designs[0].tposeIsolated, true)
  assert.equal(studio.designer.snapshot().designs[1].tposeIsolated, false)
  const model = await studio.designer.variation(cleanup, 'model', { ...request, title: '' })
  assert.equal(studio.designer.title(model), request.title)
  const workflow = JSON.parse(await readFile(join(root, 'designs', model, 'tpose-workflow.json'), 'utf8'))
  assert.equal(workflow.input.file, 'tpose.png')
  assert.deepEqual(await readFile(join(root, 'designs', model, workflow.input.file)), await readFile(join(root, 'designs', id, 'tpose.png')))
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
