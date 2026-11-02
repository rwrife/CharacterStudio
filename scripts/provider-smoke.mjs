import { _electron as electron, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Visible desktop/MCP contract coverage with deterministic local fixtures, not cloud inference.
const directory = await mkdtemp(join(tmpdir(), 'studio-provider-ui-'))
const jobs = [], cancelled = [], comfyJobs = new Map()
let png
function modelFixture(textured = false, rigged = false) {
  const binary = Buffer.alloc(Math.ceil((132 + (textured ? png.length : 0)) / 4) * 4)
  binary.writeFloatLE(1, 12); binary.writeFloatLE(1, 28)
  binary.writeFloatLE(1, 44); binary.writeFloatLE(1, 56)
  for (let vertex = 0; vertex < 3; vertex++) binary.writeFloatLE(1, 84 + vertex * 16)
  if (textured) png.copy(binary, 132)
  const document = {
    asset: { version: '2.0' }, buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 },
      { buffer: 0, byteOffset: 60, byteLength: 24 }, { buffer: 0, byteOffset: 84, byteLength: 48 },
      ...(textured ? [{ buffer: 0, byteOffset: 132, byteLength: png.length }] : [])],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }, { bufferView: 2, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' }],
    scenes: [{ nodes: rigged ? [0, 1] : [0] }], scene: 0,
    nodes: [{ mesh: 0, ...(rigged ? { skin: 0 } : {}) }, ...(rigged ? [{ name: 'Fixture root joint' }] : [])],
    ...(rigged ? { skins: [{ joints: [1] }] } : {}),
    ...(textured ? { images: [{ bufferView: 4, mimeType: 'image/png' }], textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 0 } } }] } : {}),
    meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(textured ? { TEXCOORD_0: 1 } : {}),
      ...(rigged ? { JOINTS_0: 2, WEIGHTS_0: 3 } : {}) }, ...(textured ? { material: 0 } : {}) }] }]
  }
  const json = Buffer.from(JSON.stringify(document))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(padded)
  const result = Buffer.alloc(padded.length + binary.length + 28)
  result.write('glTF'); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8)
  result.writeUInt32LE(padded.length, 12); result.write('JSON', 16); padded.copy(result, 20)
  result.writeUInt32LE(binary.length, padded.length + 20); result.write('BIN\0', padded.length + 24)
  binary.copy(result, padded.length + 28)
  return result
}
const glb = modelFixture()
let pending = false
const server = createServer(async (request, response) => {
  try {
    response.setHeader('Content-Type', 'application/json')
    let raw = ''; for await (const chunk of request) raw += chunk
    if (request.method === 'POST' && request.url === '/jobs') {
      const job = JSON.parse(raw); jobs.push(job); response.end(JSON.stringify({ id: job.id }))
    } else if (request.method === 'DELETE') {
      cancelled.push(request.url.split('/').at(-1)); response.end('{}')
    } else if (request.url.startsWith('/jobs/')) {
      const job = jobs.find(job => request.url.endsWith(job.id))
      assert.ok(job)
      response.end(JSON.stringify({ status: pending ? 'running' : 'complete', outputs:
        ['texture', 'rig'].includes(job.stage) ? { model: modelFixture(true, job.stage === 'rig').toString('base64') } : { image: png.toString('base64') } }))
    } else if (request.url === '/comfy/object_info') response.end(JSON.stringify({ FixtureMesh: {} }))
    else if (request.url === '/comfy/upload/image') {
      const name = /filename="([^"]+)"/.exec(raw)?.[1]; assert.ok(name)
      response.end(JSON.stringify({ name, subfolder: '', type: 'input' }))
    } else if (request.url === '/comfy/prompt') {
      const body = JSON.parse(raw); comfyJobs.set(body.prompt_id, body)
      response.end(JSON.stringify({ prompt_id: body.prompt_id }))
    } else if (request.url.startsWith('/comfy/history/')) {
      const id = request.url.split('/').at(-1), job = comfyJobs.get(id); assert.ok(job)
      response.end(JSON.stringify({ [id]: { status: { completed: true, status_str: 'success' },
        outputs: { '1': { '3d': [{ filename: job.prompt['1'].inputs.filename_prefix + '_1.glb', subfolder: '', type: 'output' }] } } } }))
    } else if (request.url.startsWith('/comfy/view?')) response.end(glb)
    else { response.statusCode = 404; response.end('{}') }
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })) }
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const endpoint = `http://127.0.0.1:${server.address().port}`
await writeFile(join(directory, 'studio.json'), JSON.stringify({
  settings: { comfyUrl: 'http://127.0.0.1:1', comfyRoot: directory, comfyOutput: join(directory, 'no-shared-output'), blenderPath: join(directory, 'unused-blender.exe') },
  characters: [], jobs: [], plans: [], batches: []
}))
const template = {
  version: 1, prompt: { '1': { class_type: 'FixtureMesh', inputs: { image: '', filename_prefix: '' } } },
  bindings: [{ parameter: 'image', node: '1', input: 'image' }, { parameter: 'prefix', node: '1', input: 'filename_prefix' }],
  outputs: [{ kind: 'model', node: '1', field: '3d' }]
}
const templatePath = join(directory, 'mesh-workflow.json')
await writeFile(templatePath, JSON.stringify(template))
let app, client
const errors = []
const until = async (probe, message) => expect.poll(probe, { timeout: 20000, intervals: [100, 250], message }).toBeTruthy()
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`)
  return JSON.parse(result.content[0].text)
}
const ui = () => call('studio_get_ui')
const state = () => call('studio_get_state')
const locate = async (name, role) => {
  let match
  await until(async () => {
    const matches = (await ui()).elements.filter(item => item.role === role && (name instanceof RegExp ? name.test(item.name) : item.name === name))
    assert.ok(matches.length < 2, `Ambiguous ${role}: ${name}`)
    match = matches[0]
    return match && !match.disabled
  }, `enabled ${role}: ${name}`)
  return match.ref
}
const click = async (name, role = 'button') => call('studio_click', { ref: await locate(name, role) })
const fill = async (name, value) => call('studio_set_value', { ref: await locate(name, 'textbox'), value })
const select = async (name, value) => call('studio_select', { ref: await locate(name, 'combobox'), values: [value] })
const save = async () => {
  await click('Save provider selections')
  await until(async () => (await ui()).text.includes('Provider selections saved.'), 'provider settings saved')
}
const configure = async (stage, provider, model = 'fixture-image') => {
  await select('AI stage', stage)
  await select('Execution provider', provider)
  if (provider !== 'builtin') {
    await fill('Provider endpoint no key in URL', endpoint)
    await fill('Provider model / checkpoint ID', model)
  }
  await save()
}
try {
  app = await electron.launch({ args: ['.', '--mcp'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Character lab' }).waitFor()
  png = Buffer.from(await app.evaluate(({ nativeImage }) => {
    const bitmap = Buffer.alloc(100 * 100 * 4)
    for (let y = 15; y < 85; y++) for (let x = 35; x < 65; x++) {
      const offset = (y * 100 + x) * 4
      bitmap[offset + 1] = 180; bitmap[offset + 3] = 255
    }
    return nativeImage.createFromBitmap(bitmap, { width: 100, height: 100 }).toPNG().toString('base64')
  }), 'base64')
  await until(() => readFile(join(directory, 'mcp-connection.json')).then(() => true, () => false), 'MCP connection')
  client = new Client({ name: 'provider-ui-smoke', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('scripts', 'mcp-client.mjs'), '--connection', join(directory, 'mcp-connection.json')] }))
  await click('Designer', 'tab')
  await click('Model & workflow providers')
  const originalConfiguration = (await state()).ai
  const tripoKey = 'test-only-tripo-api-key'
  await fill('Tripo API key / token OS-encrypted', tripoKey)
  assert.ok(!JSON.stringify(await ui()).includes(tripoKey), 'Default key entry is write-only through MCP.')
  await click('Save Tripo API key')
  await until(async () => (await ui()).text.includes('Tripo API key encrypted'), 'default Tripo key saved before selecting a provider')
  assert.deepEqual((await state()).ai, originalConfiguration, 'Saving a key must not enable remote generation.')
  assert.ok(!(await readFile(join(directory, 'ai-credentials.json'), 'utf8')).includes(tripoKey))
  assert.ok(!JSON.stringify(await state()).includes(tripoKey))
  await select('Execution provider', 'tripo')
  await select('Tripo image model', 'banana2')
  await fill('Tripo API key / token OS-encrypted', tripoKey)
  await select('Tripo image model', 'chat_image_1.5')
  assert.equal(await page.getByLabel('Tripo API key / token OS-encrypted').inputValue(), tripoKey, 'Model selection must not clear a key for the same endpoint.')
  await click('Save Tripo API key')
  await until(async () => (await ui()).text.includes('Tripo API key encrypted'), 'key saved while generation selections are unsaved')
  assert.deepEqual((await state()).ai, originalConfiguration)
  await fill('Provider endpoint no key in URL', 'https://openapi.tripo3d.com')
  await until(async () => (await ui()).text.includes('No Tripo API key saved'), 'official Tripo endpoint isolation')
  await fill('Tripo API key / token OS-encrypted', 'test-only-china-key')
  await click('Save Tripo API key')
  await until(async () => (await ui()).text.includes('Tripo API key encrypted'), 'separate official Tripo key')
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory, 'ai-credentials.json'), 'utf8'))).length, 2)
  await click('Remove Tripo API key')
  await until(async () => (await ui()).text.includes('Tripo API key removed.'), 'remove alternate Tripo key')
  await fill('Provider endpoint no key in URL', 'https://openapi.tripo3d.ai')
  await until(async () => (await ui()).text.includes('An encrypted Tripo API key is saved'), 'original Tripo key preserved')
  await click('Remove Tripo API key')
  await until(async () => (await ui()).text.includes('Tripo API key removed.'), 'remove default Tripo key')
  await select('Execution provider', 'inherit')
  assert.deepEqual((await state()).ai, originalConfiguration)
  assert.equal(jobs.length, 0)
  await select('AI stage', 'global')
  await select('Execution provider', 'remote-comfyui')
  await fill('Provider endpoint no key in URL', endpoint + '/comfy')
  await save()
  assert.equal((await state()).ai.globalComfy.location, 'remote')
  await select('AI stage', 'scene')
  await select('Execution provider', 'builtin')
  await select('Local image preset', 'sdxl')
  await save()
  assert.equal((await state()).designer.config.imageProfile, 'sdxl')
  assert.equal((await state()).designer.config.checkpoint, '')
  await configure('scene', 'remote-api')
  assert.equal((await state()).ai.stages.scene.location, 'remote')
  await click('Close provider settings')
  await fill('Character title optional', 'Provider UI fixture')
  await fill('Character & scenario', 'An original geometric robot in a garden')
  await fill('Art style', 'Colorful game art')
  const behind = await locate('Art style', 'textbox')
  await click('Create character concept')
  await until(async () => (await ui()).modal === 'Approve remote AI execution', 'remote approval')
  assert.equal(jobs.length, 0, 'Remote opt-in must precede all prompt and asset transmission.')
  const blocked = await client.callTool({ name: 'studio_set_value', arguments: { ref: behind, value: 'must not change' } })
  assert.equal(blocked.isError, true)
  await click('Keep data local / cancel')
  await until(async () => (await state()).designer.designs[0].status === 'failed', 'unapproved generation failure')
  assert.equal(jobs.length, 0)
  await click('Generate scene')
  await click('Approve this remote stage')
  await until(async () => !!(await state()).designer.designs[0].sceneUrl, 'gateway scene output')
  assert.equal(jobs[0].stage, 'scene')
  const designId = (await state()).designer.designs[0].id
  await click('Model & workflow providers')
  await configure('tpose', 'remote-api')
  await configure('cutout', 'local-api')
  await click('Close provider settings')
  await click('Use scene & generate T-pose')
  await click('Approve this remote stage')
  await until(async () => (await state()).designer.designs.find(design => design.id === designId).tposeIsolated, 'independent cutout output')
  assert.deepEqual(jobs.map(job => job.stage), ['scene', 'tpose', 'cutout'])
  assert.deepEqual(Buffer.from(jobs[1].inputs[0].base64, 'base64'), png)
  await click('Model & workflow providers')
  await select('AI stage', 'mesh')
  await select('Execution provider', 'remote-comfyui')
  await fill('Provider endpoint no key in URL', endpoint + '/comfy')
  await fill('Provider model / checkpoint ID', 'fixture-mesh')
  await fill('Estimated free VRAM requirement (GiB)', '100')
  await fill('Custom workflow JSON & parameter mappings', '{"version":1}')
  await click('Save provider selections')
  await until(async () => (await ui()).text.includes('Invalid input'), 'invalid workflow rejected visibly')
  assert.equal((await state()).ai.stages.mesh, undefined)
  await click('Import workflow JSON')
  await fill('Absolute file path', templatePath)
  await click('Use selected paths')
  await until(async () => (await ui()).text.includes('Workflow imported.'), 'imported workflow mappings')
  await save()
  await click('Close provider settings')
  await click('Use T-pose & generate 3D')
  await click('Approve this remote stage')
  await until(async () => !!(await state()).designer.designs.find(design => design.id === designId).modelUrl, 'ComfyUI HTTP output retrieval')
  assert.equal(comfyJobs.size, 1)
  assert.deepEqual(await readFile(join(directory, 'designs', designId, 'model.glb')), glb)
  const completed = (await state()).designer.designs.find(design => design.id === designId)
  assert.equal(completed.ai.length, 4)
  assert.ok(completed.ai.every(item => item.configurationHash && item.taskId))
  const stepModels = page.getByRole('group', { name: 'Current step models' }).getByRole('button')
  const expectStepModels = async names => {
    await expect(stepModels).toHaveCount(names.length)
    for (const [index, name] of names.entries())
      await expect(stepModels.nth(index)).toHaveAccessibleName(new RegExp(`^${name} provider:`))
  }
  await expectStepModels(['3D mesh generation'])
  await click(/T-pose reference/)
  await expectStepModels(['T-pose editing', 'Background removal'])
  await click(/Character & scene/)
  await expectStepModels(['Scene / concept'])
  assert.ok(!(await ui()).elements.some(item => item.role === 'button' && /Create (PBR texture|rigged GLB) variation/.test(item.name)))
  await click(/3D model Geometry or textured GLB/)
  await expectStepModels(['3D mesh generation'])

  await click('Model & workflow providers')
  await configure('texture', 'local-api', 'fixture-pbr')
  await click('Close provider settings')
  await expectStepModels(['3D mesh generation', 'PBR texturing'])
  await click('Create PBR texture variation')
  await until(async () => (await state()).designer.designs[0].modelTextured, 'validated PBR variation')
  const textured = (await state()).designer.designs[0]
  assert.notEqual(textured.id, designId)
  assert.deepEqual(await readFile(join(directory, 'designs', textured.id, 'original-model.glb')), glb)
  await click('Model & workflow providers')
  await configure('rig', 'remote-api', 'fixture-rig')
  await click('Close provider settings')
  await click('Create rigged GLB variation')
  await until(async () => (await ui()).modal === 'Approve remote AI execution', 'mesh upload approval')
  assert.equal(jobs.length, 4)
  assert.ok((await ui()).text.includes('Character mesh and embedded textures'))
  await click('Approve this remote stage')
  await until(async () => (await state()).designer.designs[0].modelRigged, 'validated skinned GLB variation')
  const rigged = (await state()).designer.designs[0]
  assert.ok(rigged.modelTextured)
  assert.equal(rigged.ai.at(-1).stage, 'rig')
  await click('Save rigged GLB')
  const riggedExport = join(directory, 'exported-rig.glb')
  await fill('Absolute file path', riggedExport)
  await click('Save selected file')
  await until(() => readFile(riggedExport).then(bytes => bytes.equals(modelFixture(true, true)), () => false), 'byte-preserving rigged mesh export')
  assert.deepEqual((await state()).designer.designs.find(design => design.id === designId), completed)
  await click('Model & workflow providers')
  await select('AI stage', 'mesh')
  await select('Execution provider', 'tripo')
  assert.equal(await page.getByLabel('Maximum triangles', { exact: true }).inputValue(), '')
  await expect(page.getByRole('checkbox', { name: 'Smart low-poly', exact: true })).not.toBeChecked()
  await fill('Maximum triangles', '50000')
  await save()
  assert.deepEqual((await state()).ai.stages.mesh.tripoMesh, { maxTriangles: 50000 })
  await click('Smart low-poly', 'checkbox')
  await click('Save provider selections')
  await until(async () => (await ui()).text.includes('between 500 and 20,000'), 'incompatible low-poly budget rejected visibly')
  assert.deepEqual((await state()).ai.stages.mesh.tripoMesh, { maxTriangles: 50000 }, 'Invalid edits must not overwrite saved settings.')
  await fill('Maximum triangles', '20000')
  await save()
  await click('Use automatic triangle count')
  await save()
  assert.deepEqual((await state()).ai.stages.mesh.tripoMesh, { smartLowPoly: true })
  await click('Smart low-poly', 'checkbox')
  await save()
  assert.equal((await state()).ai.stages.mesh.tripoMesh, undefined, 'Clearing both controls restores unchanged provider defaults.')
  await fill('Maximum triangles', '20000')
  await click('Smart low-poly', 'checkbox')
  await save()
  for (const stage of ['scene', 'tpose', 'texture', 'rig']) {
    await select('AI stage', stage)
    assert.ok(!(await ui()).elements.some(item => item.name === 'Maximum triangles' || item.name === 'Smart low-poly'))
  }
  await select('AI stage', 'mesh')
  assert.equal(await page.getByLabel('Maximum triangles', { exact: true }).inputValue(), '20000')
  await click('Close provider settings')
  pending = true
  await click(/Character & scene/)
  await click('Generate scene')
  await click('Approve this remote stage')
  await until(() => jobs.length === 6, 'pending gateway job')
  await click('Model & workflow providers')
  const lockedKey = (await ui()).elements.find(item => item.name === 'Tripo API key / token OS-encrypted' && item.role === 'textbox')
  assert.equal(lockedKey?.disabled, true, 'Credential edits must remain locked during generation.')
  const refusedKey = await client.callTool({ name: 'studio_set_value', arguments: { ref: lockedKey.ref, value: 'must-not-save' } })
  assert.equal(refusedKey.isError, true)
  await click('Close provider settings')
  await click('Cancel design')
  await until(async () => (await state()).designer.designs[0].status === 'cancelled', 'gateway cancellation')
  assert.equal(cancelled[0], jobs[5].id)
  assert.deepEqual((await state()).designer.designs.find(design => design.id === designId), completed)

  await click('Model & workflow providers')
  await select('AI stage', 'motion')
  await select('Execution provider', 'remote-comfyui')
  await fill('Provider endpoint no key in URL', 'https://credentials.example')
  await save()
  const fakeKey = 'test-only-not-a-real-api-key'
  await fill('API key / bearer token OS-encrypted', fakeKey)
  assert.ok(!JSON.stringify(await ui()).includes(fakeKey), 'MCP inspection must redact password values.')
  await click('Save encrypted credential')
  await until(async () => (await ui()).text.includes('API credential encrypted'), 'OS credential encryption')
  assert.ok(!(await readFile(join(directory, 'ai-credentials.json'), 'utf8')).includes(fakeKey))
  assert.ok(!JSON.stringify(await state()).includes(fakeKey))
  await fill('Provider endpoint no key in URL', 'https://different.example')
  await save()
  await until(async () => (await ui()).text.includes('No credential saved for this endpoint.'), 'credential endpoint isolation')
  await fill('Provider endpoint no key in URL', 'https://credentials.example')
  await save()
  await until(async () => (await ui()).text.includes('An encrypted credential is saved'), 'original credential retained')
  await click('Remove credential')
  await until(async () => (await ui()).text.includes('Credential removed.'), 'credential removal')

  await select('AI stage', 'scene')
  await select('Execution provider', 'tripo')
  const tripoOptions = (await ui()).elements.find(item => item.role === 'combobox' && item.name === 'Tripo image model').options
  assert.ok(!tripoOptions.some(option => ['midjourney', 'flux.1_dev', 'flux.1_kontext_pro', 'gpt_image_1.5'].includes(option.value)))
  await select('Tripo image model', 'custom')
  await fill('Provider model / checkpoint ID', 'midjourney')
  assert.ok((await ui()).text.includes('not supported by Tripo v3'))
  await save()
  assert.equal((await state()).ai.stages.scene.model, 'midjourney')
  await select('Tripo image model', 'banana2')
  assert.ok(!(await ui()).elements.some(item => item.role === 'textbox' && item.name === 'Provider model / checkpoint ID'))
  assert.ok((await ui()).text.includes('Nano Banana 2 supports text prompts and reference-image editing.'))
  assert.ok(!(await ui()).text.includes('not supported by Tripo v3'))
  await select('Tripo image model', 'custom')
  await fill('Provider model / checkpoint ID', 'custom-image-fixture')
  await save()
  assert.equal((await state()).ai.stages.scene.model, 'custom-image-fixture')
  await click('Close provider settings')
  await click('Model & workflow providers')
  await select('AI stage', 'scene')
  assert.equal(await page.getByLabel('Provider model / checkpoint ID', { exact: true }).inputValue(), 'custom-image-fixture')
  await select('Tripo image model', 'banana2')
  await save()
  assert.equal((await state()).ai.stages.scene.model, 'banana2')
  assert.ok(!(await ui()).elements.some(item => item.role === 'textbox' && item.name === 'Provider model / checkpoint ID'))
  await fill('Tripo API key / token OS-encrypted', tripoKey)
  await click('Save Tripo API key')
  await until(async () => (await ui()).text.includes('Tripo API key encrypted'), 'fake key for rejection fixture')
  await app.evaluate((_, { encodedPng, encodedGlb }) => {
    const originalFetch = globalThis.fetch
    globalThis.providerSmokeRequests = []
    globalThis.providerSmokeSuccess = false
    globalThis.providerSmokeMeshPending = true
    globalThis.providerSmokeRestoreFetch = () => { globalThis.fetch = originalFetch }
    globalThis.fetch = async (input, options) => {
      const url = String(input)
      if (url.startsWith('https://openapi.tripo3d.ai/')) {
        globalThis.providerSmokeRequests.push({ url, method: options?.method, body: options?.body })
        if (globalThis.providerSmokeSuccess && url.endsWith('/generation/text-to-image')) {
          const model = JSON.parse(options.body).model
          if (!['banana', 'banana2', 'banana_pro', 'chat_image_1', 'chat_image_1.5', 'chat_image_2',
            'chat_image_2.5_flare', 'chat_image_2.5_sunburst', 'seedream_v4', 'seedream_v5'].includes(model))
            return Response.json({ code: 1004, message: `invalid model for text-to-image: ${model}` }, { status: 400 })
          return Response.json({ code: 0, data: { task_id: 'tripo_legacy_fixture' } })
        }
        if (globalThis.providerSmokeSuccess && url.endsWith('/tasks/tripo_legacy_fixture'))
          return Response.json({ code: 0, data: { status: 'success', output: { generated_image_url: 'https://assets.tripo3d.ai/fixture.png' } } })
        if (globalThis.providerSmokeSuccess && url.endsWith('/files'))
          return Response.json({ code: 0, data: { file_token: 'tripo_mesh_image_fixture' } })
        if (globalThis.providerSmokeSuccess && url.endsWith('/generation/image-to-model')) {
          const body = JSON.parse(options.body)
          if (body.face_limit !== 20000 || body.smart_low_poly !== true || body.quad !== undefined)
            return Response.json({ code: 1004, message: 'Fixture expected 20,000 triangles, Smart low-poly and no quad conversion.' }, { status: 400 })
          return Response.json({ code: 0, data: { task_id: 'tripo_mesh_fixture' } })
        }
        if (globalThis.providerSmokeSuccess && url.endsWith('/tasks/tripo_mesh_fixture'))
          return Response.json({ code: 0, data: { status: globalThis.providerSmokeMeshPending ? 'running' : 'success',
            output: { model_url: 'https://assets.tripo3d.ai/fixture.glb' } } })
        return Response.json({
          code: 1004, message: 'Fixture: selected model was rejected. test-only-tripo-api-key',
          suggestion: 'Check the image model for this task.'
        }, { status: 400, headers: { 'X-Tripo-Trace-ID': '20516a36-f45c-4454-83c8-45877b75eac8' } })
      }
      if (url === 'https://assets.tripo3d.ai/fixture.png') {
        if (options?.headers) throw new Error('Fixture image download must not receive credentials.')
        return new Response(Buffer.from(encodedPng, 'base64'))
      }
      if (url === 'https://assets.tripo3d.ai/fixture.glb') {
        if (options?.headers) throw new Error('Fixture model download must not receive credentials.')
        return new Response(Buffer.from(encodedGlb, 'base64'))
      }
      return originalFetch(input, options)
    }
  }, { encodedPng: png.toString('base64'), encodedGlb: modelFixture(true).toString('base64') })
  await click('Close provider settings')
  await click('Generate scene')
  await until(async () => (await ui()).modal === 'Approve remote AI execution', 'Tripo fixture approval')
  assert.ok((await ui()).text.includes('Model: Nano Banana 2'))
  await click('Approve this remote stage')
  await until(async () => (await state()).designer.designs[0].status === 'failed', 'Tripo HTTP 400 surfaced in the desktop')
  assert.ok((await ui()).text.includes('HTTP 400; code 1004'))
  assert.ok((await ui()).text.includes('Fixture: selected model was rejected. [redacted]'))
  assert.ok((await ui()).text.includes('Trace ID: 20516a36-f45c-4454-83c8-45877b75eac8'))
  assert.ok(!JSON.stringify(await state()).includes(tripoKey))
  assert.ok(!JSON.stringify(await ui()).includes(tripoKey))
  assert.equal((await app.evaluate(() => globalThis.providerSmokeRequests)).length, 1, 'A rejected paid submission must not be retried.')
  await click('Model & workflow providers')
  await select('AI stage', 'scene')
  await select('Tripo image model', 'custom')
  await fill('Provider model / checkpoint ID', 'gpt_image_1.5')
  await save()
  await click('Close provider settings')
  await click('Model & workflow providers')
  await select('AI stage', 'scene')
  assert.equal(await page.getByLabel('Tripo image model', { exact: true }).inputValue(), 'chat_image_1.5')
  assert.ok(!(await ui()).elements.some(item => item.role === 'textbox' && item.name === 'Provider model / checkpoint ID'))
  assert.equal((await state()).ai.stages.scene.model, 'gpt_image_1.5', 'Recognizing a saved alias must not rewrite history.')
  await click('Close provider settings')
  await app.evaluate(() => { globalThis.providerSmokeSuccess = true })
  await click('Generate scene')
  await until(async () => (await ui()).modal === 'Approve remote AI execution', 'saved legacy model approval')
  assert.ok((await ui()).text.includes('Model: GPT Image 1.5'))
  await click('Approve this remote stage')
  await until(async () => (await state()).designer.designs[0].status === 'idle', 'legacy selection succeeds against strict v3 fixture')
  const translated = (await state()).designer.designs[0]
  assert.ok(translated.sceneUrl)
  assert.equal(translated.ai.at(-1).route.model, 'chat_image_1.5')
  assert.equal((await state()).ai.stages.scene.model, 'gpt_image_1.5')
  const tripoRequests = await app.evaluate(() => globalThis.providerSmokeRequests)
  assert.equal(tripoRequests.length, 3, 'Exactly two explicit submissions and one success poll are expected.')
  assert.equal(tripoRequests[0].url, 'https://openapi.tripo3d.ai/v3/generation/text-to-image')
  assert.equal(JSON.parse(tripoRequests[0].body).model, 'banana2')
  assert.equal(JSON.parse(tripoRequests[1].body).model, 'chat_image_1.5')
  pending = false
  await click('Use scene & generate T-pose')
  await click('Approve this remote stage')
  await until(async () => (await state()).designer.designs[0].tposeIsolated, 'T-pose for triangle-settings fixture')
  await click('Use T-pose & generate 3D')
  await until(async () => (await ui()).modal === 'Approve remote AI execution', 'mesh triangle settings approval')
  assert.ok((await ui()).text.includes('Maximum triangles: 20,000'))
  assert.ok((await ui()).text.includes('Smart low-poly: on'))
  assert.equal((await app.evaluate(() => globalThis.providerSmokeRequests)).length, 3, 'Triangle settings must not bypass upload consent.')
  await click('Approve this remote stage')
  await until(async () => (await app.evaluate(() => globalThis.providerSmokeRequests)).some(item => item.url.endsWith('/tasks/tripo_mesh_fixture')), 'pending triangle-constrained mesh')
  await click(/^3D mesh generation provider:/)
  const lockedTriangles = (await ui()).elements.find(item => item.name === 'Maximum triangles')
  const lockedLowPoly = (await ui()).elements.find(item => item.name === 'Smart low-poly')
  assert.equal(lockedTriangles?.disabled, true)
  assert.equal(lockedLowPoly?.disabled, true)
  assert.equal((await client.callTool({ name: 'studio_set_value', arguments: { ref: lockedTriangles.ref, value: '10000' } })).isError, true)
  assert.equal((await client.callTool({ name: 'studio_click', arguments: { ref: lockedLowPoly.ref } })).isError, true)
  await click('Close provider settings')
  await app.evaluate(() => { globalThis.providerSmokeMeshPending = false })
  await until(async () => !!(await state()).designer.designs[0].modelUrl && (await state()).designer.designs[0].status === 'idle', 'triangle-constrained GLB reaches the desktop')
  const triangleDesign = (await state()).designer.designs[0]
  assert.deepEqual(triangleDesign.ai.findLast(item => item.stage === 'mesh').route.tripoMesh, { maxTriangles: 20000, smartLowPoly: true })
  assert.deepEqual((await state()).designer.designs.find(design => design.id === designId), completed)
  const meshRequests = await app.evaluate(() => {
    globalThis.providerSmokeRestoreFetch()
    return globalThis.providerSmokeRequests.filter(item => item.url.endsWith('/generation/image-to-model'))
  })
  assert.equal(meshRequests.length, 1)
  assert.deepEqual(JSON.parse(meshRequests[0].body), {
    input: 'tripo_mesh_image_fixture', model: 'v3.1-20260211', model_seed: 42, texture: true, pbr: true,
    face_limit: 20000, smart_low_poly: true
  })
  await click('Model & workflow providers')
  await select('AI stage', 'scene')
  await select('Tripo image model', 'banana2')
  await save()
  await click('Remove Tripo API key')
  await until(async () => (await ui()).text.includes('Tripo API key removed.'), 'remove rejection-fixture key')
  await page.setViewportSize({ width: 1440, height: 1600 })
  await call('studio_scroll', { ref: await locate('Model and workflow providers', 'dialog'), y: -10000 })
  await mkdir(resolve('docs', 'screenshots'), { recursive: true })
  const screenshot = await client.callTool({ name: 'studio_screenshot', arguments: {} })
  assert.equal(screenshot.content[0].type, 'image')
  await writeFile(resolve('docs', 'screenshots', 'ai-providers.png'), Buffer.from(screenshot.content[0].data, 'base64'))
  await select('AI stage', 'mesh')
  await page.setViewportSize({ width: 1440, height: 2100 })
  await call('studio_scroll', { ref: await locate('Model and workflow providers', 'dialog'), y: -10000 })
  const meshScreenshot = await client.callTool({ name: 'studio_screenshot', arguments: {} })
  assert.equal(meshScreenshot.content[0].type, 'image')
  await writeFile(resolve('docs', 'screenshots', 'tripo-mesh-settings.png'), Buffer.from(meshScreenshot.content[0].data, 'base64'))
  await client.close(); client = undefined
  await app.close(); app = undefined
  const saved = JSON.parse(await readFile(join(directory, 'ai-providers.json'), 'utf8'))
  assert.equal(saved.configuration.stages.scene.model, 'banana2')
  assert.deepEqual(saved.configuration.stages.mesh.tripoMesh, { maxTriangles: 20000, smartLowPoly: true })
  assert.ok(saved.history.length >= 8)
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory, 'ai-credentials.json'), 'utf8'))).length, 0)
  app = await electron.launch({ args: ['.', '--mcp'], env: { ...process.env, STUDIO_SKIP_SETUP_CHECKLIST: '1', STUDIO_NO_AUTO_INSTALL: '1', STUDIO_DATA_DIR: directory }, timeout: 60000 })
  const reopened = await app.firstWindow()
  reopened.on('pageerror', error => errors.push(error.message))
  await reopened.getByRole('heading', { name: 'Character lab' }).waitFor()
  client = new Client({ name: 'provider-ui-restart', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('scripts', 'mcp-client.mjs'), '--connection', join(directory, 'mcp-connection.json')] }))
  assert.deepEqual((await state()).ai, saved.configuration)
  assert.deepEqual((await state()).designer.designs.find(design => design.id === rigged.id), rigged)
  // Asset URLs are re-registered at startup; saved data and the displayed image must remain unchanged.
  const { tposeUrl: originalPoseUrl, ...beforeRestart } = triangleDesign
  const { tposeUrl: restoredPoseUrl, ...afterRestart } = (await state()).designer.designs.find(design => design.id === triangleDesign.id)
  assert.ok(originalPoseUrl && restoredPoseUrl)
  assert.deepEqual(afterRestart, beforeRestart)
  assert.deepEqual(Buffer.from(await reopened.evaluate(async url => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), restoredPoseUrl)), png)
  await click('Designer', 'tab')
  await click('Model & workflow providers')
  await select('AI stage', 'mesh')
  assert.equal(await reopened.getByLabel('Maximum triangles', { exact: true }).inputValue(), '20000')
  await expect(reopened.getByRole('checkbox', { name: 'Smart low-poly', exact: true })).toBeChecked()
  assert.deepEqual(errors, [])
  console.log('Provider MCP smoke passed: default Tripo key entry, custom-only model IDs, current-step models, triangle budgets/low-poly validation, approval, request payloads and locks, global/native/stage selections, workflow import/invalid mappings, mixed routing, real PNG/PBR/skinned GLB variations, credential redaction/isolation, actionable redacted HTTP 400, cancellation and provenance after restart. Fixtures only; no cloud requests or learned inference.')
} finally {
  await client?.close()
  await app?.close()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
