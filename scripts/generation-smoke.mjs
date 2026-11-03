import { _electron as electron, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { imageWorkflow, tposeWorkflow, meshWorkflow } from '../src/main/design-workflows.ts'
import { designConfigSchema } from '../src/main/designer.ts'

// Local deterministic fixtures exercise desktop reruns, not learned inference.
const directory = await mkdtemp(join(tmpdir(), 'studio-generation-ui-'))
const output = join(directory, 'output')
await mkdir(output)
const config = designConfigSchema.parse({
  imageProfile: 'sd15', checkpoint: 'scene-a.safetensors', controlnet: '',
  meshProfile: 'mini', meshCheckpoint: 'hunyuan3d-dit-v2-mini.safetensors', titleModel: '',
  backgroundModel: 'birefnet.safetensors'
})
const brief = { title: 'Generation fixture', description: 'A stylized robot in a garden', style: 'Colorful game art', seed: 42, steps: 30, referenceStrength: 0.3 }
const catalog = Object.fromEntries([
  ...Object.values(imageWorkflow(config, brief, 'fixture')),
  ...Object.values(tposeWorkflow(config, brief, 'fixture', 'scene.png')),
  ...Object.values(meshWorkflow(config, brief, 'fixture', 'pose.png'))
].map(node => [node.class_type, { input: { required: {} } }]))
for (const [node, field, choices] of [
  ['CheckpointLoaderSimple', 'ckpt_name', ['scene-a.safetensors', 'scene-b.safetensors', config.meshCheckpoint]],
  ['UNETLoader', 'unet_name', [config.editModel]],
  ['CLIPLoader', 'clip_name', [config.editTextEncoder]],
  ['VAELoader', 'vae_name', [config.editVae]],
  ['LoadBackgroundRemovalModel', 'bg_removal_name', [config.backgroundModel]]
]) catalog[node].input.required[field] = [choices]
const json = Buffer.from(JSON.stringify({
  asset: { version: '2.0' }, buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }]
}))
const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32)
json.copy(padded)
const glb = Buffer.alloc(padded.length + 64)
glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
glb.writeUInt32LE(padded.length, 12); glb.write('JSON', 16); padded.copy(glb, 20)
glb.writeUInt32LE(36, padded.length + 20); glb.write('BIN\0', padded.length + 24)
glb.writeFloatLE(1, padded.length + 40); glb.writeFloatLE(1, padded.length + 56)
const submissions = new Map()
let png, pending = false, fail = false
const server = createServer(async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/system_stats') {
      res.end(JSON.stringify({ devices: [{ name: 'TEST-ONLY GPU', type: 'cuda', vram_total: 32 * 2 ** 30, vram_free: 32 * 2 ** 30 }] }))
    } else if (req.url === '/object_info') res.end(JSON.stringify(catalog))
    else if (req.url === '/prompt') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const model = body.prompt['9']?.class_type === 'SaveGLB'
      const node = model ? '9' : '7'
      const filename = body.prompt[node].inputs.filename_prefix + (model ? '_00001_.glb' : '_00001_.png')
      await writeFile(join(output, filename), model ? glb : png)
      submissions.set(body.prompt_id, { body, filename, node, model })
      res.end(JSON.stringify({ prompt_id: body.prompt_id }))
    } else if (req.url.startsWith('/history/')) {
      const id = req.url.slice('/history/'.length), item = submissions.get(id)
      res.end(JSON.stringify(!item || pending ? {} : { [id]: {
        status: { completed: !fail, status_str: fail ? 'error' : 'success',
          messages: fail ? [['execution_error', { exception_message: 'TEST-ONLY generation failure' }]] : [] },
        outputs: { [item.node]: { [item.model ? '3d' : 'images']: [{ filename: item.filename, subfolder: '', type: 'output' }] } }
      } }))
    } else if (req.url === '/upload/image') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const name = /filename="([^"]+)"/.exec(raw)?.[1]
      assert.ok(name)
      res.end(JSON.stringify({ name, subfolder: '', type: 'input' }))
    } else if (/^\/api\/jobs\/[^/]+\/cancel$/.test(req.url)) res.end('{}')
    else { res.statusCode = 404; res.end('{}') }
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })) }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
await writeFile(join(directory, 'designer.json'), JSON.stringify({ config, designs: [], references: [] }))
await writeFile(join(directory, 'studio.json'), JSON.stringify({
  settings: { comfyUrl: `http://127.0.0.1:${address.port}`, comfyRoot: directory, comfyOutput: output, blenderPath: join(directory, 'unused-blender.exe') },
  characters: [], jobs: [], plans: [], batches: []
}))
let app, client
const until = async probe => {
  await expect.poll(probe, { timeout: 20000, intervals: [100, 250] }).toBeTruthy()
}
try {
  app = await electron.launch({ args: ['.', '--mcp'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  const page = await app.firstWindow()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  png = Buffer.from(await app.evaluate(({ nativeImage }) => {
    const bitmap = Buffer.alloc(100 * 100 * 4)
    for (let y = 15; y < 85; y++) for (let x = 35; x < 65; x++) {
      const offset = (y * 100 + x) * 4
      bitmap[offset + 1] = 180; bitmap[offset + 3] = 255
    }
    return nativeImage.createFromBitmap(bitmap, { width: 100, height: 100 }).toPNG().toString('base64')
  }), 'base64')
  client = new Client({ name: 'generation-regression', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve('scripts', 'mcp-client.mjs'), '--connection', join(directory, 'mcp-connection.json')]
  }))
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, JSON.stringify(result.content))
    return JSON.parse(result.content[0].text)
  }
  const state = () => call('studio_get_state')
  const control = async name => {
    const ui = await call('studio_get_ui')
    const matches = ui.elements.filter(el => el.name === name)
    assert.equal(matches.length, 1, `Expected one control: ${name}`)
    return matches[0]
  }
  const click = async name => call('studio_click', { ref: (await control(name)).ref })
  const fill = async (name, value) => call('studio_set_value', { ref: (await control(name)).ref, value })
  const regeneration = async expected => {
    const ui = await call('studio_get_ui')
    assert.deepEqual(ui.elements.filter(el => /^Regenerate (scene|T-pose|3D)$/.test(el.name)).map(el => el.name), [expected])
    assert.equal((await control(expected)).disabled, false)
  }
  const completed = async () => {
    await until(async () => (await state()).designer.designs[0]?.status === 'idle')
    await until(async () => (await call('studio_get_ui')).elements.some(el => /^Regenerate /.test(el.name) && !el.disabled))
    return (await state()).designer.designs[0]
  }
  await click('Designer')
  await fill('Character title optional', brief.title)
  await fill('Character & scenario', brief.description)
  await fill('Art style', brief.style)
  await click('Animator')
  await click('Designer')
  assert.equal((await call('studio_get_ui')).modal, null)
  assert.equal((await call('studio_get_ui')).elements.some(el => el.name === 'Installed image checkpoint'), false)
  assert.equal(await page.getByLabel('Character & scenario', { exact: true }).inputValue(), brief.description)
  await mkdir(resolve('docs', 'screenshots'), { recursive: true })
  await page.screenshot({ path: resolve('docs', 'screenshots', 'designer-models-collapsed.png') })
  await click('Create character concept')
  await completed()
  await regeneration('Regenerate scene')
  await click('T-pose reference')
  await click('Use scene & generate T-pose')
  await completed()
  await regeneration('Regenerate T-pose')
  await click('3D model')
  await click('Use T-pose & generate 3D')
  const original = await completed()
  const originalBytes = await readFile(join(directory, 'designs', original.id, 'model.glb'))
  await regeneration('Regenerate 3D')
  await click('T-pose reference')
  await regeneration('Regenerate T-pose')
  await click('Character & scene')
  await regeneration('Regenerate scene')
  await click('3D model')
  await regeneration('Regenerate 3D')
  await click('Regenerate 3D')
  const model = await completed()
  assert.notEqual(model.id, original.id)
  assert.equal(model.modelUrl !== original.modelUrl, true)
  assert.equal(model.tposeIsolated, true)
  await regeneration('Regenerate 3D')
  await click('Character & scene')
  if (!await page.getByRole('tabpanel', { name: 'Designer' }).getByText('Advanced generation', { exact: true }).evaluate(el => el.parentElement.open)) await click('Advanced generation')
  await fill('Design seed', '101')
  await fill('Character & scenario', 'A different robot exploring a city')
  await click('T-pose reference')
  await click('Regenerate T-pose')
  const pose = await completed()
  assert.equal(pose.modelUrl, undefined)
  assert.equal(pose.request.seed, 101)
  assert.equal(pose.request.description, 'A different robot exploring a city')
  await regeneration('Regenerate T-pose')
  await click('3D model')
  assert.equal((await control('Use T-pose & generate 3D')).disabled, false)
  await click('Character & scene')
  await regeneration('Regenerate scene')
  const regenerationRef = (await control('Regenerate scene')).ref
  await click('Model Settings')
  await call('studio_select', { ref: (await control('Installed image checkpoint')).ref, values: ['scene-b.safetensors'] })
  assert.equal((await client.callTool({ name: 'studio_click', arguments: { ref: regenerationRef } })).isError, true, 'Unsaved modal settings cannot be bypassed to generate.')
  await click('Close Model Settings')
  assert.ok((await call('studio_get_ui')).text.includes('You have unsaved settings'))
  await click('Continue editing')
  assert.equal(await page.getByLabel('Installed image checkpoint', { exact: true }).inputValue(), 'scene-b.safetensors')
  await click('Save settings')
  await until(async () => (await state()).designer.config.checkpoint === 'scene-b.safetensors')
  await click('Close Model Settings')
  pending = true
  await click('Regenerate scene')
  await until(async () => (await state()).designer.designs[0]?.status === 'running')
  assert.equal((await control('Generate scene')).disabled, true, 'Concurrent submissions must stay blocked.')
  await click('Model Settings')
  assert.equal((await control('Installed image checkpoint')).disabled, true)
  assert.equal((await state()).designer.designs[0]?.status, 'running', 'Opening settings must not interrupt generation.')
  await click('Close Model Settings')
  pending = false
  const scene = await completed()
  assert.equal(scene.config.checkpoint, 'scene-b.safetensors')
  assert.equal(scene.request.seed, 101)
  assert.equal(scene.tposeUrl, undefined)
  assert.equal(scene.modelUrl, undefined)
  const last = [...submissions.values()].at(-1).body.prompt
  assert.equal(last['1'].inputs.ckpt_name, 'scene-b.safetensors')
  assert.match(last['2'].inputs.text, /different robot exploring a city/)
  assert.equal(last['5'].inputs.seed, 101)
  fail = true
  await click('Regenerate scene')
  await until(async () => (await state()).designer.designs[0]?.status === 'failed')
  await expect(page.getByRole('alert')).toContainText('TEST-ONLY generation failure')
  await until(async () => !(await control('Generate scene')).disabled)
  await click('Review model settings')
  assert.equal((await call('studio_get_ui')).modal, 'Model Settings')
  await expect(page.getByLabel('Image model family')).toBeFocused()
  await click('Close Model Settings')
  fail = false
  await click('Generate scene')
  const retried = await completed()
  assert.ok(retried.sceneUrl)
  const saved = (await state()).designer.designs.find(d => d.id === original.id)
  assert.deepEqual(saved, original)
  assert.deepEqual(await readFile(join(directory, 'designs', original.id, 'model.glb')), originalBytes)
  await page.reload()
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  await click('Designer')
  await until(async () => (await state()).designer.designs.some(d => d.id === retried.id && d.sceneUrl))
  assert.deepEqual((await state()).designer.designs.find(d => d.id === original.id), original)
  console.log('Generation smoke passed: step-scoped regeneration controls; real MCP/UI scene, T-pose and 3D reruns; edited prompts/seed/models; busy locks; failure/retry; immutable outputs; persistence. Deterministic fixtures only, not learned inference.')
} finally {
  await client?.close()
  await app?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
