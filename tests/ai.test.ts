import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { aiConfigurationSchema, aiModelLabel, aiRouteLabel, aiRouteSchema, aiStages, defaultAiConfiguration, localRoute, providerUrl, resolveAiCredentialRoute, resolveAiRoute, tripoImageModelId, tripoImageModels, workflowSchema,
  type AiProvenance, type AiRoute, type AiStage, type WorkflowTemplate } from '../src/shared/ai'
import { AiProviders, bindWorkflow, hashConfiguration, motionProviderTemplate, nativeTemplate, validateMotionMetadata } from '../src/main/ai-providers'
import { AiCredentials, type CredentialEncryption } from '../src/main/ai-credentials'
import { AiNetwork, boundedBody, decodeBase64, downloadTripoOutput } from '../src/main/ai-network'
import { RemoteConsent } from '../src/main/ai-consent'
import { Studio } from '../src/main/studio'
import { designConfigSchema } from '../src/main/designer'
import { tposeWorkflow } from '../src/main/design-workflows'
import { defaultLandmarks } from '../src/shared/rig'

const settings = { comfyUrl: 'http://127.0.0.1:1', comfyRoot: 'unavailable', comfyOutput: 'unavailable', blenderPath: 'unavailable' }
const brief = { title: 'Routing fixture', description: 'An original robot', style: 'Game art', seed: 42, steps: 20, referenceStrength: 0.3 }
const route = (endpoint: string, provider: AiRoute['provider'] = 'api', location: AiRoute['location'] = 'remote'): AiRoute =>
  ({ provider, location, endpoint, model: provider === 'api' ? 'fixture-model' : '', minVramGB: 0 })
async function temp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'studio-ai-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
function encryption(): CredentialEncryption {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-cipher',
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
}
function imageTemplate(): WorkflowTemplate {
  return workflowSchema.parse({
    version: 1,
    prompt: { '1': { class_type: 'FixtureImage', inputs: { text: '', image: '', seed: 0, filename_prefix: '', checkpoint: '' } } },
    bindings: [
      { parameter: 'prompt', node: '1', input: 'text' }, { parameter: 'image', node: '1', input: 'image' },
      { parameter: 'seed', node: '1', input: 'seed' }, { parameter: 'prefix', node: '1', input: 'filename_prefix' },
      { parameter: 'model', node: '1', input: 'checkpoint' }
    ],
    outputs: [{ kind: 'image', node: '1', field: 'images' }]
  })
}
function glb(skinned = false): Buffer {
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    nodes: [{ mesh: 0, ...(skinned ? { skin: 0 } : {}) }], skins: skinned ? [{ joints: [1] }] : [],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(skinned ? { JOINTS_0: 1, WEIGHTS_0: 2 } : {}) } }] }]
  }))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(padded)
  const bytes = Buffer.alloc(28 + padded.length + 36)
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(padded.length, 12); bytes.write('JSON', 16); padded.copy(bytes, 20)
  bytes.writeUInt32LE(36, 20 + padded.length); bytes.write('BIN\0', 24 + padded.length)
  return bytes
}

test('native routed T-pose prepares an image-conditioned graph before upload and keeps cutout independent', async t => {
  const root = await temp(t), providers = new AiProviders(root, () => settings)
  providers.confirm = async () => true
  const image = join(root, 'scene.png'); await writeFile(image, 'scene fixture')
  const config = designConfigSchema.parse({ imageProfile: 'sd15', checkpoint: '', controlnet: '', meshProfile: 'mini', meshCheckpoint: '', titleModel: '' })
  let graph: ReturnType<typeof tposeWorkflow> = {}, id = '', uploaded = ''
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const address = String(url)
    if (address.endsWith('/object_info')) return Response.json(Object.fromEntries(
      Object.values(tposeWorkflow(config, brief, 'prefix', 'input.png', false)).map(node => [node.class_type, {}])))
    if (address.endsWith('/upload/image')) {
      assert.ok(options?.body instanceof FormData)
      const file = options.body.get('image'); assert.ok(file && typeof file !== 'string')
      assert.equal(await file.text(), 'scene fixture')
      uploaded = file.name
      return Response.json({ name: uploaded, subfolder: '', type: 'input' })
    }
    if (address.endsWith('/prompt')) {
      const body = JSON.parse(String(options?.body)); graph = body.prompt; id = body.prompt_id
      return Response.json({ prompt_id: id })
    }
    if (address.includes('/history/')) return Response.json({ [id]: {
      status: { completed: true, status_str: 'success' }, outputs: { '7': { images: [{
        filename: graph['7'].inputs.filename_prefix + '_0001.png', subfolder: '', type: 'output'
      }] } }
    } })
    assert.ok(address.includes('/view?'))
    return new Response('pose fixture')
  })
  const output = await providers.execute({
    stage: 'tpose', route: route('https://gpu.example', 'comfyui'), prompt: 'Edit this scene', image, seed: 42, steps: 20,
    native: parameters => nativeTemplate(tposeWorkflow(config, brief, String(parameters.prefix), String(parameters.image), false), 'image', '7'),
    signal: AbortSignal.timeout(5000), progress: () => {}, submitted: () => {}, record: async () => {}
  })
  assert.equal(output.image?.toString(), 'pose fixture')
  assert.equal(graph['4'].inputs.image, uploaded)
  assert.equal(graph['14'].inputs.steps, 4)
  assert.deepEqual(graph['7'].inputs.images, ['23', 0])
  assert.ok(!Object.values(graph).some(node => node.class_type === 'RemoveBackground'))
})

test('routing remains local by default, validates explicit remote endpoints and resolves stage overrides', () => {
  assert.deepEqual(resolveAiRoute(undefined, 'motion'), localRoute)
  const remote = route('https://gpu.example/comfy/', 'comfyui')
  const config = aiConfigurationSchema.parse({ version: 1, globalComfy: remote, stages: { cutout: localRoute } })
  assert.equal(resolveAiRoute(config, 'scene').endpoint, 'https://gpu.example/comfy')
  assert.deepEqual(resolveAiRoute(config, 'cutout'), localRoute)
  assert.deepEqual(resolveAiRoute(config, 'naming'), localRoute)
  assert.equal(providerUrl('http://192.168.2.30:8188'), 'http://192.168.2.30:8188')
  for (const endpoint of ['file:///secret', 'https://name:key@cloud.example', 'https://cloud.example?key=private', 'https://cloud.example/#token']) {
    assert.throws(() => aiRouteSchema.parse(route(endpoint)))
  }
  assert.throws(() => aiRouteSchema.parse(route('https://cloud.example', 'api', 'local')), /loopback/)
  assert.throws(() => aiRouteSchema.parse(route('https://not-tripo.example', 'tripo')), /official/)
  assert.throws(() => aiConfigurationSchema.parse({ version: 1, stages: { motion: route('https://openapi.tripo3d.ai', 'tripo') } }), /not a provider/)
  assert.throws(() => aiConfigurationSchema.parse({ version: 1, stages: {}, token: 'not-allowed' }))
})

test('templates have explicit bindings and output contracts, preserve checkpoint subfolders, and reject secrets or ignored constraints', () => {
  const template = imageTemplate()
  const graph = bindWorkflow(template, { prompt: 'character', image: 'uploaded.png', seed: 23, prefix: 'studio_abc', model: 'custom/model.safetensors' })
  assert.deepEqual(graph['1'].inputs, { text: 'character', image: 'uploaded.png', seed: 23, filename_prefix: 'studio_abc', checkpoint: 'custom/model.safetensors' })
  assert.equal(template.prompt['1'].inputs.text, '')
  assert.throws(() => bindWorkflow(template, {}), /needs a prompt/)
  assert.throws(() => workflowSchema.parse({ ...template, bindings: [{ parameter: 'prompt', node: 'missing', input: 'text' }] }), /missing input/)
  assert.throws(() => workflowSchema.parse({ ...template, outputs: [...template.outputs, ...template.outputs] }), /unique/)
  assert.throws(() => workflowSchema.parse({ ...template, prompt: { '1': { class_type: 'FixtureImage', inputs: { api_key: 'do-not-persist' } } } }), /credentials/)
  assert.throws(() => aiConfigurationSchema.parse({ version: 1, stages: { motion: { ...route('https://gpu.example', 'comfyui'), workflow: template } } }), /npz output/)
  const motion = motionProviderTemplate({ ...brief, characterId: 'x', prompt: 'walk', seconds: 2, inPlace: false },
    { prefix: 'studio_prefix', constraints: '[{"pose":1}]', model: 'custom-motion' }, 'lfm')
  assert.equal(motion.prompt['1'].class_type, 'Studio_Kimodo_LoadLFM')
  assert.equal(motion.prompt['1'].inputs.model, 'custom-motion')
  assert.equal(motion.prompt['3'].class_type, 'Studio_Kimodo_Sampler')
  assert.equal(motion.prompt['3'].inputs.constraints_json, '[{"pose":1}]')
  motion.prompt['3'].class_type = 'Kimodo_Sampler'
  motion.bindings.push({ parameter: 'constraints', node: '3', input: 'constraints_json' })
  assert.throws(() => aiConfigurationSchema.parse({ version: 1, stages: { motion: { ...route('https://gpu.example', 'comfyui'), workflow: motion } } }), /ignores inline JSON/)
})

test('Tripo triangle budgets validate model and mode limits without changing existing defaults', () => {
  const chosen = { ...route('https://openapi.tripo3d.ai', 'tripo'), model: 'v3.1-20260211' }
  const config = { version: 1, stages: { mesh: chosen } }
  assert.deepEqual(aiConfigurationSchema.parse(config), config)
  for (const [model, maximum] of [['v3.1-20260211', 1_500_000], ['v3.0-20250812', 1_000_000], ['v2.5-20250123', 500_000]] as const) {
    for (const maxTriangles of [1, 20_000, maximum])
      assert.equal(aiRouteSchema.parse({ ...chosen, model, tripoMesh: { maxTriangles } }).tripoMesh?.maxTriangles, maxTriangles)
    assert.throws(() => aiRouteSchema.parse({ ...chosen, model, tripoMesh: { maxTriangles: maximum + 1 } }), /Maximum triangles/)
  }
  for (const maxTriangles of [-1, 0, 1.5, NaN, Infinity, '20000'])
    assert.equal(aiRouteSchema.safeParse({ ...chosen, tripoMesh: { maxTriangles } }).success, false)
  for (const maxTriangles of [undefined, 500, 20_000])
    assert.equal(aiRouteSchema.parse({ ...chosen, tripoMesh: { maxTriangles, smartLowPoly: true } }).tripoMesh?.smartLowPoly, true)
  for (const maxTriangles of [499, 20_001])
    assert.throws(() => aiRouteSchema.parse({ ...chosen, tripoMesh: { maxTriangles, smartLowPoly: true } }), /between 500 and 20,000/)
  for (const model of ['v2.5-20250123', 'P1-20260311'])
    assert.throws(() => aiRouteSchema.parse({ ...chosen, model, tripoMesh: { smartLowPoly: true } }), /not supported/)
  const meshRoute = { ...chosen, tripoMesh: { maxTriangles: 20_000, smartLowPoly: true } }
  for (const stage of ['scene', 'tpose', 'texture', 'rig'])
    assert.throws(() => aiConfigurationSchema.parse({ version: 1, stages: { [stage]: meshRoute } }), /only to 3D mesh/)
  assert.throws(() => aiRouteSchema.parse({ ...meshRoute, provider: 'api' }), /require the Tripo/)
  assert.throws(() => aiRouteSchema.parse({ ...chosen, tripoMesh: { quad: true } }), /Unrecognized key/)
  assert.equal(aiRouteSchema.safeParse({ ...chosen, tripoMesh: { smartLowPoly: 'true' } }).success, false)
  assert.notEqual(hashConfiguration(chosen), hashConfiguration(meshRoute))
  assert.notEqual(hashConfiguration(meshRoute), hashConfiguration({ ...meshRoute, tripoMesh: { maxTriangles: 10_000, smartLowPoly: true } }))
})

test('Tripo keys can be saved before choosing a route without changing local defaults or endpoint scopes', async t => {
  const root = await temp(t), vault = new AiCredentials(root, encryption())
  const config = structuredClone(defaultAiConfiguration)
  const chosen = resolveAiCredentialRoute(config, 'tripo')
  assert.equal(chosen.endpoint, 'https://openapi.tripo3d.ai')
  assert.equal(chosen.provider, 'tripo')
  vault.set(chosen, 'test-only-preset-token')
  assert.equal(vault.get({ ...chosen, model: 'gemini_3.1_flash_image_preview' }), 'test-only-preset-token')
  assert.equal(vault.get({ ...chosen, model: 'v3.1-20260211', tripoMesh: { maxTriangles: 20_000, smartLowPoly: true } }), 'test-only-preset-token')
  assert.equal(vault.has(resolveAiCredentialRoute(config, 'tripo-com')), false)
  assert.equal(vault.has({ ...chosen, provider: 'api' }), false)
  assert.deepEqual(config, defaultAiConfiguration)
  for (const stage of Object.keys(aiStages) as AiStage[]) assert.deepEqual(resolveAiRoute(config, stage), localRoute)
  const remote = route('https://gpu.example', 'comfyui')
  const configured = aiConfigurationSchema.parse({ version: 1, stages: { scene: chosen }, globalComfy: remote })
  assert.equal(vault.get(resolveAiCredentialRoute(configured, 'scene')), 'test-only-preset-token')
  assert.deepEqual(resolveAiCredentialRoute(configured, 'global'), remote)
  assert.deepEqual(resolveAiCredentialRoute(configured, 'motion'), remote)
  assert.throws(() => resolveAiCredentialRoute(config, 'global'), /Save a global/)
  for (const target of ['https://different.example', 'unknown', { provider: 'tripo', endpoint: 'https://different.example' }])
    assert.throws(() => resolveAiCredentialRoute(config, target))
  vault.set(resolveAiCredentialRoute(config, 'tripo-com'), 'test-only-china-token')
  vault.set(chosen, '')
  assert.equal(vault.has(chosen), false)
  assert.equal(vault.get(resolveAiCredentialRoute(config, 'tripo-com')), 'test-only-china-token')
})

test('Tripo presets use friendly labels without changing stored or custom model IDs', () => {
  for (const [model, label] of Object.entries(tripoImageModels)) {
    const chosen = { ...route('https://openapi.tripo3d.ai', 'tripo'), model }
    assert.equal(aiModelLabel(chosen), label)
    assert.equal(aiRouteLabel({ version: 1, stages: { scene: chosen } }, 'scene'), `Remote / Tripo (paid) / ${label}`)
    assert.equal(chosen.model, model)
  }
  assert.equal(aiModelLabel({ provider: 'tripo', model: 'custom-image-model' }), 'custom-image-model')
  assert.equal(aiModelLabel({ provider: 'tripo', model: 'gemini_3.1_flash_image_preview' }), 'Nano Banana 2')
  assert.equal(aiModelLabel({ provider: 'tripo', model: 'gpt_image_1.5' }), 'GPT Image 1.5')
  assert.equal(tripoImageModelId('custom-image-model'), 'custom-image-model')
  assert.equal(tripoImageModelId('banana2'), 'banana2')
  assert.equal(tripoImageModelId('constructor'), 'constructor')
  assert.equal(aiModelLabel({ provider: 'api', model: 'gemini_3.1_flash_image_preview' }), 'gemini_3.1_flash_image_preview')
})

test('credentials are encrypted, endpoint-bound, never returned in configuration and fail closed without OS encryption', async t => {
  const root = await temp(t), crypto = encryption(), vault = new AiCredentials(root, crypto)
  const chosen = route('https://gpu.example', 'comfyui')
  vault.set(chosen, 'test-only-token')
  assert.equal(vault.get(chosen), 'test-only-token')
  const disk = await readFile(join(root, 'ai-credentials.json'), 'utf8')
  assert.ok(!disk.includes('test-only-token'))
  assert.ok(!disk.includes('gpu.example'))
  assert.equal(vault.get({ ...chosen, endpoint: 'https://different.example' }), undefined)
  assert.equal(vault.get({ ...chosen, provider: 'api' }), undefined)
  assert.equal(new AiCredentials(root, crypto).get(chosen), 'test-only-token')
  const insecure = new AiCredentials(root, { ...crypto, getSelectedStorageBackend: () => 'basic_text' })
  assert.throws(() => insecure.get(chosen), /No plaintext fallback/)
  assert.throws(() => insecure.set(chosen, 'test'), /No plaintext fallback/)
  assert.throws(() => vault.set(route('http://127.0.0.1:8000'), 'test'), /HTTPS/)
  assert.throws(() => vault.set(chosen, 'test\r\nother'), /pattern/)
  vault.set(chosen, '')
  assert.equal(vault.has(chosen), false)
})

test('remote approval is one-shot, stale replies fail, abort withdraws the modal', async () => {
  const changes: (string | null)[] = []
  const consent = new RemoteConsent(request => changes.push(request?.id ?? null))
  const controller = new AbortController()
  const request = { id: 'first', stage: 'scene' as const, endpoint: 'https://gpu.example', provider: 'api' as const, model: 'model', inputs: ['prompt'] }
  const pending = consent.request(request, controller.signal)
  assert.throws(() => consent.reply('stale', true), /stale/)
  consent.reply('first', true)
  assert.equal(await pending, true)
  assert.throws(() => consent.reply('first', true), /stale/)
  const second = consent.request({ ...request, id: 'second' }, controller.signal)
  controller.abort()
  assert.equal(await second, false)
  assert.deepEqual(changes, ['first', null, 'second', null])
})

test('bounded transport rejects oversized, empty and invalid outputs without echoing server secrets', async () => {
  await assert.rejects(boundedBody(new Response('test-only-token', { status: 401 }), 100), /HTTP 401/)
  await assert.rejects(boundedBody(new Response('oversized'), 2), /size/)
  await assert.rejects(boundedBody(new Response(''), 20), /empty/)
  assert.throws(() => decodeBase64('not-base64', 20), /invalid/)
  assert.throws(() => decodeBase64(Buffer.from('large').toString('base64'), 2), /oversized/)
  for (const url of ['file:///secret', 'https://127.0.0.1/secret', 'https://tripo3d.ai.attacker.example/a', 'https://user:pass@cdn.tripo3d.ai/a'])
    await assert.rejects(downloadTripoOutput(url, AbortSignal.timeout(100), 20))
  assert.throws(() => new AiNetwork(route('http://lan.example'), 'test-only-token'), /HTTPS/)
})

test('Tripo HTTP and API rejections retain diagnostic details without leaking credentials or retrying', async t => {
  const secret = 'test-only-secret+/value'
  const network = new AiNetwork(route('https://openapi.tripo3d.ai', 'tripo'), secret)
  const trace = '20516a36-f45c-4454-83c8-45877b75eac8'
  const payload = {
    code: 1004, message: `Invalid model parameter; ${secret}; ${encodeURIComponent(secret)}; ${Buffer.from(secret).toString('base64')}`,
    suggestion: 'Check the image model for this task. Bearer tsk_another-key https://example.com/?token=private',
    request_id: trace, ignored: { token: secret }
  }
  let status = 400, calls = 0, body: unknown = payload
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json(body, { status, headers: { 'X-Tripo-Trace-ID': trace } })
  })
  const reject = () => assert.rejects(network.tripo('/v3/generation/text-to-image', AbortSignal.timeout(5000), { prompt: 'fixture' }),
    (error: Error) => {
      assert.match(error.message, /Tripo \/v3\/generation\/text-to-image failed/)
      assert.match(error.message, /code 1004/)
      assert.match(error.message, /Invalid model parameter/)
      assert.match(error.message, /Check the image model for this task/)
      assert.ok(error.message.includes(`Trace ID: ${trace}`))
      for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), 'tsk_another-key', 'token=private'])
        assert.ok(!error.message.includes(value))
      if (status === 400) assert.match(error.message, /HTTP 400/)
      return true
    })
  await reject()
  status = 200
  await reject()
  body = { status: 'error', message: 'Request rejected', request_id: trace }
  await assert.rejects(network.tripo('/v3/account/balance', AbortSignal.timeout(5000)), /Trace ID.*Request rejected/)
  assert.equal(calls, 3, 'Neither a paid submission nor a failed read is retried automatically.')
  body = { code: 1004, message: 'Invalid parameter. '.repeat(5000), request_id: trace }
  await assert.rejects(network.tripo('/v3/account/balance', AbortSignal.timeout(5000)), (error: Error) => {
    assert.ok(error.message.length <= 1600)
    assert.ok(error.message.includes(`Trace ID: ${trace}`))
    return true
  })
})

test('Tripo non-JSON, malformed and empty HTTP errors never echo the response body', async t => {
  const network = new AiNetwork(route('https://openapi.tripo3d.ai', 'tripo'), 'test-only-key')
  let body = '<html>private-response-test-only-key</html>'
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 400 }))
  for (const value of [body, '', '{"message":{"token":"private-response-test-only-key"}}']) {
    body = value
    await assert.rejects(network.tripo('/v3/generation/text-to-image', AbortSignal.timeout(5000), { prompt: 'fixture' }),
      (error: Error) => {
        assert.match(error.message, /HTTP 400/)
        assert.ok(!error.message.includes('private-response'))
        assert.ok(!error.message.includes('test-only-key'))
        return true
      })
  }
})

interface FixtureJob {
  id: string; stage: AiStage; prompt: string; model: string; seed: number; steps: number; seconds?: number
  constraints?: unknown; inputs: { kind: string; base64: string }[]
}
async function gateway(t: TestContext) {
  const jobs: FixtureJob[] = [], cancelled: string[] = []
  const state = { pending: false, failed: false, bad: false, output: Buffer.from('fixture-image'), metadata: { num_joints: 77, num_frames: 60, fps: 30 } }
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'POST' && request.url === '/jobs') {
      let body = ''
      for await (const part of request) body += part
      const job = JSON.parse(body) as FixtureJob
      jobs.push(job); response.end(JSON.stringify({ id: job.id }))
    } else if (request.method === 'DELETE') {
      cancelled.push(request.url!.split('/').at(-1)!)
      response.end('{}')
    } else {
      const job = jobs.find(job => `/jobs/${job.id}` === request.url)
      if (!job) { response.statusCode = 404; response.end('{}'); return }
      const outputs = state.bad ? {} : job.stage === 'naming' ? { text: 'Named by fixture' } :
        job.stage === 'motion' ? { npz: Buffer.from('fixture-npz').toString('base64'), bvh: Buffer.from('fixture-bvh').toString('base64'), metadata: state.metadata } :
          { [job.stage === 'scene' || job.stage === 'tpose' || job.stage === 'cutout' ? 'image' : 'model']:
            (job.stage === 'mesh' ? glb() : job.stage === 'rig' ? glb(true) : state.output).toString('base64') }
      response.end(JSON.stringify({ status: state.failed ? 'failed' : state.pending ? 'running' : 'complete', outputs }))
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { endpoint: `http://127.0.0.1:${address.port}`, jobs, cancelled, state }
}

test('remote gateway requires approval before network, preserves inputs and constraints, and cancels only its job', async t => {
  const remote = await gateway(t), root = await temp(t)
  const providers = new AiProviders(root, () => settings)
  providers.save({ version: 1, stages: { motion: route(remote.endpoint) } })
  const records: AiProvenance[] = []
  const controller = new AbortController()
  const options = {
    stage: 'motion' as const, prompt: 'A person walks', seed: 23, steps: 60, seconds: 2,
    constraints: [{ frame_indices: [0, 59], pose: 'actual incoming context' }],
    signal: controller.signal, submitted: () => {}, progress: () => {},
    record: async (value: AiProvenance) => { records.push(structuredClone(value)) }
  }
  providers.confirm = async () => false
  await assert.rejects(providers.execute(options), /not approved/)
  assert.equal(remote.jobs.length, 0)
  providers.confirm = async request => { assert.ok(request.inputs.some(input => input.includes('pose constraints'))); return true }
  const result = await providers.execute(options)
  assert.equal(result.npz?.toString(), 'fixture-npz')
  assert.deepEqual(remote.jobs[0].constraints, options.constraints)
  assert.equal(remote.jobs[0].seed, 23)
  assert.equal(result.metadata?.num_frames, 60)
  assert.match(records.at(-1)!.configurationHash, /^[a-f0-9]{64}$/)
  remote.state.pending = true
  await assert.rejects(providers.execute({ ...options, progress: message => { if (message.startsWith('Waiting for fixture-model')) controller.abort() } }))
  assert.equal(remote.cancelled[0], remote.jobs[1].id)
  assert.equal(remote.cancelled.length, 1)
})

test('invalid motion frames or missing outputs are never returned as successful generation', async t => {
  const remote = await gateway(t), providers = new AiProviders(await temp(t), () => settings)
  providers.confirm = async () => true
  const options = { stage: 'motion' as const, route: route(remote.endpoint), prompt: 'walk', seed: 2, steps: 20, seconds: 2,
    signal: AbortSignal.timeout(5000), submitted: () => {}, progress: () => {}, record: async () => {} }
  remote.state.metadata.num_frames = 59
  await assert.rejects(providers.execute(options), /expected 60/)
  remote.state.bad = true
  await assert.rejects(providers.execute(options), /required motion output/)
  assert.throws(() => validateMotionMetadata({ num_joints: 30, num_frames: 60, fps: 30 }, 2, 'walk'))
  assert.throws(() => validateMotionMetadata({ num_joints: 77, num_frames: 1801, fps: 30 }, 60, 'walk'))
})

test('custom ComfyUI uploads actual image, binds model/seed, downloads scoped output and records exact workflow', async t => {
  const root = await temp(t), input = join(root, 'input.png')
  await writeFile(input, 'actual reference bytes')
  let prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}
  let id = '', uploaded = '', requests = 0
  const state = { badPath: false, apiNode: false }
  const server = createServer(async (request, response) => {
    requests++
    response.setHeader('Content-Type', 'application/json')
    let body = ''; for await (const chunk of request) body += chunk
    if (request.url === '/object_info') response.end(JSON.stringify({ FixtureImage: { api_node: state.apiNode } }))
    else if (request.url === '/upload/image') {
      assert.match(body, /actual reference bytes/)
      uploaded = /filename="([^"]+)"/.exec(body)![1]
      response.end(JSON.stringify({ name: uploaded, subfolder: '', type: 'input' }))
    } else if (request.url === '/prompt') {
      const data = JSON.parse(body); prompt = data.prompt; id = data.prompt_id
      response.end(JSON.stringify({ prompt_id: id }))
    } else if (request.url?.startsWith('/history/')) response.end(JSON.stringify({
      [id]: { status: { completed: true, status_str: 'success' }, outputs: { '1': { images: [{
        filename: `${prompt['1'].inputs.filename_prefix}_0001.png`, subfolder: state.badPath ? '../private' : '', type: 'output'
      }] } } }
    }))
    else if (request.url?.startsWith('/view?')) response.end('completed png fixture')
    else { response.statusCode = 404; response.end('{}') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const selected = { ...route(`http://127.0.0.1:${address.port}`, 'comfyui'), workflow: imageTemplate(), model: 'custom/my-model.safetensors', minVramGB: 100 }
  const providers = new AiProviders(root, () => settings)
  let recorded: unknown
  providers.confirm = async () => { assert.equal(requests, 0); return true }
  const options = { stage: 'tpose' as const, route: selected, image: input, prompt: 'Preserve this character', seed: 42, steps: 20,
    signal: AbortSignal.timeout(5000), submitted: () => {}, progress: () => {},
    record: async (_: AiProvenance, workflow?: unknown) => { if (workflow) recorded = workflow } }
  assert.equal((await providers.execute(options)).image?.toString(), 'completed png fixture')
  assert.equal(prompt['1'].inputs.image, uploaded)
  assert.equal(prompt['1'].inputs.checkpoint, selected.model)
  assert.equal(prompt['1'].inputs.seed, 42)
  assert.deepEqual(recorded, prompt)
  providers.confirm = async () => true
  state.badPath = true
  await assert.rejects(providers.execute(options), /output descriptor/)
  state.apiNode = true
  await assert.rejects(providers.execute({ ...options, route: { ...selected, location: 'local' } }), /cannot execute cloud/)
})

test('routed Designer stages complete without local inference and preserve originals, provenance and encrypted configuration boundaries', async t => {
  const remote = await gateway(t), root = await temp(t)
  const decoded: { file: string; cutout?: boolean }[] = []
  const studio = new Studio(root, root, async (file, cutout) => { decoded.push({ file, cutout }); return readFile(file) })
  studio.ai.confirm = async () => true
  studio.saveSettings(settings)
  const all = Object.fromEntries((['naming', 'scene', 'tpose', 'cutout', 'mesh', 'rig'] as const).map(stage => [stage, route(remote.endpoint)]))
  studio.saveAiSettings({ version: 1, stages: all })
  const id = studio.designer.create({ ...brief, title: '' })
  await studio.designer.run(id, 'scene')
  await studio.designer.run(id, 'tpose')
  await studio.designer.run(id, 'model')
  assert.deepEqual(remote.jobs.map(job => job.stage), ['naming', 'scene', 'tpose', 'cutout', 'mesh'])
  assert.equal(Buffer.from(remote.jobs[2].inputs[0].base64, 'base64').toString(), 'fixture-image')
  assert.ok(remote.jobs[2].prompt.includes('T-pose'))
  for (const job of remote.jobs.filter(job => ['scene', 'tpose'].includes(job.stage)))
    assert.ok(job.prompt.includes('exactly five fingers'), 'Routed prompts must retain the shared anatomy default.')
  assert.ok(!remote.jobs[2].prompt.includes(brief.description), 'T-pose edit must not reinterpret the character brief.')
  assert.ok(decoded.some(item => item.cutout))
  const original = studio.designer.snapshot().designs.find(design => design.id === id)!
  assert.ok(original.sceneUrl && original.tposeUrl && original.tposeIsolated && original.modelUrl)
  assert.equal(original.title, 'Named by fixture')
  assert.equal(original.ai?.length, 5)
  const riggedId = await studio.designer.processModel(id, 'rig')
  assert.notEqual(riggedId, id)
  assert.deepEqual(studio.designer.snapshot().designs.find(design => design.id === id), original)
  assert.equal(studio.designer.snapshot().designs.find(design => design.id === riggedId)?.modelRigged, true)
  const restarted = new Studio(root, root)
  assert.deepEqual(restarted.ai.snapshot(), studio.ai.snapshot())
  assert.equal(restarted.designer.snapshot().designs.find(design => design.id === id)?.ai?.length, 5)
  const history = JSON.parse(await readFile(join(root, 'ai-providers.json'), 'utf8'))
  assert.equal(history.history.length, 1)
  remote.state.bad = true
  const failedId = studio.designer.create(brief)
  await assert.rejects(studio.designer.run(failedId, 'scene'), /required scene output/)
  assert.equal(studio.designer.snapshot().designs.find(design => design.id === failedId)?.sceneUrl, undefined)
})

test('configuration hashes are stable and saved batches refuse provider drift', async t => {
  assert.equal(hashConfiguration({ model: 'a', endpoint: 'b' }), hashConfiguration({ endpoint: 'b', model: 'a' }))
  const root = await temp(t)
  const studio = new Studio(root, root)
  const planId = '11111111-1111-4111-8111-111111111111'
  const snapshot = studio.snapshot()
  await writeFile(join(root, 'studio.json'), JSON.stringify({ ...snapshot, batches: [{
    id: planId, name: 'Immutable batch', createdAt: '', status: 'complete', aiRoute: localRoute,
    plan: { id: planId, name: 'plan', graphVersion: 2, rigSetup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() }, nodes: [], edges: [], entryNodeIds: [] },
    request: { planId, characterIds: [], seedStride: 0, autoRig: false }, items: []
  }] }))
  const loaded = new Studio(root, root)
  loaded.saveAiSettings({ version: 1, stages: { motion: route('https://gateway.example') } })
  await assert.rejects(loaded.rerunBatch(planId), /original motion provider/)
})

test('Tripo v3 uses paid credential headers only on API requests, exact routes and token uploads', async t => {
  const root = await temp(t), providers = new AiProviders(root, () => settings)
  const chosen = { ...route('https://openapi.tripo3d.ai', 'tripo'), model: 'v3.1-20260211' }
  providers.credentials = new AiCredentials(root, encryption())
  providers.credentials.set(chosen, 'test-only-tripo-key')
  providers.confirm = async () => true
  const image = join(root, 'reference.png'); await writeFile(image, 'fixture')
  const calls: { url: string; options?: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const address = String(url); calls.push({ url: address, options })
    if (address.includes('/v3/files')) return Response.json({ code: 0, data: { file_token: 'file_test' } })
    if (address.includes('/v3/generation/image-to-model')) {
      assert.deepEqual(JSON.parse(String(options?.body)), { input: 'file_test', model: 'v3.1-20260211', model_seed: 42, texture: true, pbr: true })
      return Response.json({ code: 0, data: { task_id: 'task_test' } })
    }
    if (address.includes('/v3/tasks/')) return Response.json({ code: 0, data: { status: 'success', output: { model_url: 'https://assets.tripo3d.ai/fixture.glb?signature=test' } } })
    if (address.includes('/v3/account/balance')) return Response.json({ code: 0, data: { balance: 100, frozen: 5 } })
    assert.equal(address, 'https://assets.tripo3d.ai/fixture.glb?signature=test')
    assert.equal(options?.headers, undefined)
    return new Response(new Uint8Array(glb()))
  })

  await t.test('Tripo triangle settings survive reload and reach approval, mesh requests and immutable provenance', async t => {
    const root = await temp(t), providers = new AiProviders(root, () => settings)
    const chosen = { ...route('https://openapi.tripo3d.ai', 'tripo'), model: 'v3.1-20260211' }
    providers.credentials = new AiCredentials(root, encryption())
    providers.credentials.set(chosen, 'test-only-key')
    const approvals: string[][] = [], records: AiProvenance[] = [], requests: Record<string, unknown>[] = []
    let networkCalls = 0
    providers.confirm = async request => { approvals.push(request.inputs); return true }
    const image = join(root, 'reference.png'); await writeFile(image, 'original image')
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
      networkCalls++
      const address = String(url)
      if (address.endsWith('/files')) return Response.json({ code: 0, data: { file_token: 'reference_file' } })
      if (address.endsWith('/generation/image-to-model')) {
        requests.push(JSON.parse(String(options?.body)))
        return Response.json({ code: 0, data: { task_id: `mesh_${requests.length}` } })
      }
      if (address.includes('/tasks/')) return Response.json({ code: 0, data: {
        status: 'success', output: { model_url: 'https://assets.tripo3d.ai/model.glb' }
      } })
      assert.equal(address, 'https://assets.tripo3d.ai/model.glb')
      assert.equal(options?.headers, undefined)
      return new Response(new Uint8Array(glb()))
    })
    const options = { stage: 'mesh' as const, prompt: 'robot', image, seed: 42, steps: 20,
      signal: AbortSignal.timeout(5000), progress: () => {}, submitted: () => {},
      record: async (record: AiProvenance) => { records.push(structuredClone(record)) } }
    for (const badRoute of [
      { ...chosen, tripoMesh: { maxTriangles: 0 } },
      { ...chosen, tripoMesh: { maxTriangles: 20_001, smartLowPoly: true } },
      { ...chosen, model: 'v2.5-20250123', tripoMesh: { smartLowPoly: true } }
    ]) await assert.rejects(providers.execute({ ...options, route: badRoute }), /triangles|low-poly/)
    await assert.rejects(providers.execute({ ...options, stage: 'texture', route: { ...chosen, tripoMesh: { maxTriangles: 20_000 } } }), /only to 3D mesh/)
    assert.equal(approvals.length, 0)
    assert.equal(networkCalls, 0, 'Invalid settings must fail before uploading or spending credits.')
    const cases: { tripoMesh: AiRoute['tripoMesh']; expected: Record<string, number | boolean> }[] = [
      { tripoMesh: undefined, expected: {} },
      { tripoMesh: { maxTriangles: 50_000 }, expected: { face_limit: 50_000 } },
      { tripoMesh: { maxTriangles: 20_000, smartLowPoly: true }, expected: { face_limit: 20_000, smart_low_poly: true } },
      { tripoMesh: { smartLowPoly: true }, expected: { smart_low_poly: true } },
      { tripoMesh: { maxTriangles: 10_000, smartLowPoly: false }, expected: { face_limit: 10_000, smart_low_poly: false } }
    ]
    for (const { tripoMesh, expected } of cases) {
      const savedRoute = { ...chosen, ...(tripoMesh ? { tripoMesh } : {}) }
      const previousRecords = structuredClone(records)
      providers.save({ version: 1, stages: { mesh: savedRoute } })
      assert.deepEqual(new AiProviders(root, () => settings).route('mesh'), savedRoute)
      const output = await providers.execute(options)
      assert.deepEqual(output.model, glb())
      assert.deepEqual(requests.at(-1), {
        input: 'reference_file', model: chosen.model, model_seed: 42, texture: true, pbr: true, ...expected
      })
      assert.deepEqual(records.at(-1)?.route, savedRoute)
      assert.equal(records.at(-1)?.configurationHash, hashConfiguration(savedRoute))
      assert.deepEqual(records.slice(0, previousRecords.length), previousRecords)
      if (tripoMesh) {
        assert.ok(approvals.at(-1)?.includes(`Maximum triangles: ${tripoMesh.maxTriangles?.toLocaleString('en-US') ?? 'Automatic'}`))
        assert.ok(approvals.at(-1)?.includes(`Smart low-poly: ${tripoMesh.smartLowPoly ? 'on' : 'off'}`))
      }
    }
    assert.equal(requests.length, cases.length)
    assert.equal(await readFile(image, 'utf8'), 'original image')
  })

  await t.test('Tripo v3 image requests translate saved aliases and reject unsupported models without substitution', async t => {
    const root = await temp(t), providers = new AiProviders(root, () => settings)
    const chosen = { ...route('https://openapi.tripo3d.ai', 'tripo'), model: 'gemini_2.5_flash_image_preview' }
    providers.credentials = new AiCredentials(root, encryption())
    providers.credentials.set(chosen, 'test-only-key')
    const approvals: string[] = [], records: AiProvenance[] = []
    providers.confirm = async request => { approvals.push(request.model); return true }
    const image = join(root, 'input.png'); await writeFile(image, 'fixture')
    const calls: { url: string; body?: unknown }[] = []
    // Independent v3 server allowlist: deriving it from Studio's presets would hide obsolete IDs.
    const allowedModels = new Set(['banana', 'banana2', 'banana_pro', 'chat_image_1', 'chat_image_1.5',
      'chat_image_2', 'chat_image_2.5_flare', 'chat_image_2.5_sunburst', 'seedream_v4', 'seedream_v5'])
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
      const address = String(url)
      const body = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined
      calls.push({ url: address, body })
      if (address.endsWith('/files')) return Response.json({ code: 0, data: { file_token: 'image_file' } })
      if (address.includes('/generation/')) {
        if (!allowedModels.has(body?.model)) return Response.json({
          code: 1004, message: `invalid model for text-to-image: ${body?.model}`
        }, { status: 400 })
        return Response.json({ code: 0, data: { task_id: 'image_task' } })
      }
      if (address.includes('/tasks/')) return Response.json({ code: 0, data: { status: 'success', output: { generated_image_url: 'https://assets.tripo3d.ai/image.png' } } })
      assert.equal(address, 'https://assets.tripo3d.ai/image.png')
      assert.equal(options?.headers, undefined)
      return new Response('image fixture')
    })
    const options = { stage: 'scene' as const, route: chosen, prompt: 'original robot', seed: 42, steps: 20,
      signal: AbortSignal.timeout(5000), progress: () => {}, submitted: () => {},
      record: async (record: AiProvenance) => { records.push(structuredClone(record)) } }
    await assert.rejects(new AiNetwork(chosen, 'test-only-key').tripo('/v3/generation/text-to-image',
      options.signal, { model: 'gpt_image_1.5', prompt: options.prompt }), /HTTP 400; code 1004.*invalid model/)
    calls.length = 0
    for (const model of ['midjourney', 'flux.1_dev', 'flux.1_kontext_pro']) {
      await assert.rejects(providers.execute({ ...options, route: { ...chosen, model } }), /not supported by Tripo v3/)
      await assert.rejects(providers.execute({ ...options, image, route: { ...chosen, model } }), /not supported by Tripo v3/)
    }
    await assert.rejects(providers.execute({ ...options, image, route: { ...chosen, model: 'seedream_v4' } }), /text-only/)
    await assert.rejects(providers.execute({ ...options, image, prompt: 'x'.repeat(1025) }), /1,024/)
    assert.equal(calls.length, 0)
    for (const model of Object.keys(tripoImageModels)) {
      await providers.execute({ ...options, route: { ...chosen, model } })
      assert.deepEqual(calls.findLast(call => call.url.endsWith('/text-to-image'))?.body, { model, prompt: options.prompt })
    }
    const aliases = [
      ['gemini_2.5_flash_image_preview', 'banana'],
      ['gemini_3_pro_image_preview', 'banana_pro'],
      ['gemini_3.1_flash_image_preview', 'banana2'],
      ['gpt_4o', 'chat_image_1'],
      ['gpt_image_1.5', 'chat_image_1.5'],
      ['gpt_image_2', 'chat_image_2']
    ] as const
    for (const [legacy, model] of aliases) {
      const savedRoute = { ...chosen, model: legacy }
      const before = structuredClone(savedRoute)
      await providers.execute({ ...options, route: savedRoute })
      assert.deepEqual(calls.findLast(call => call.url.endsWith('/text-to-image'))?.body, { model, prompt: options.prompt })
      assert.equal(approvals.at(-1), model)
      assert.equal(records.at(-1)?.route.model, model)
      assert.equal(records.at(-1)?.configurationHash, hashConfiguration({ ...savedRoute, model }))
      await providers.execute({ ...options, stage: 'tpose', image, route: savedRoute })
      assert.deepEqual(calls.findLast(call => call.url.endsWith('/image-to-image'))?.body,
        { input: 'image_file', model, prompt: options.prompt, t_pose: true })
      assert.equal(records.at(-1)?.route.model, model)
      assert.deepEqual(savedRoute, before, 'Existing selections and completed records must not be rewritten.')
    }
    await providers.execute({ ...options, route: { ...chosen, model: 'seedream_v5' } })
    assert.equal(records.at(-1)?.route.model, 'seedream_v5', 'Other explicitly selected v3 model IDs are unchanged.')
  })

  await t.test('Tripo imports meshes before rigging/texturing and preserves every paid task ID with cancellation warnings', async t => {
    const root = await temp(t), providers = new AiProviders(root, () => settings)
    const chosen = { ...route('https://openapi.tripo3d.ai', 'tripo'), model: 'fixture-model' }
    providers.credentials = new AiCredentials(root, encryption())
    providers.credentials.set(chosen, 'test-only-key')
    providers.confirm = async () => true
    const mesh = join(root, 'model.glb'); await writeFile(mesh, glb())
    const calls: { url: string; body?: unknown }[] = []
    let running = false
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
      const address = String(url)
      const body = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined
      calls.push({ url: address, body })
      if (address.endsWith('/files')) return Response.json({ code: 0, data: { file_token: 'mesh_file' } })
      if (address.endsWith('/models/import')) return Response.json({ code: 0, data: { task_id: 'import_task' } })
      if (address.endsWith('/animations/rig') || address.endsWith('/models/texture')) return Response.json({ code: 0, data: { task_id: 'output_task' } })
      if (address.includes('/tasks/')) return Response.json({ code: 0, data: { status: running ? 'running' : 'success', output: { model_url: 'https://assets.tripo3d.ai/model.glb' } } })
      assert.equal(address, 'https://assets.tripo3d.ai/model.glb')
      return new Response(new Uint8Array(glb(true)))
    })
    const records: AiProvenance[] = []
    const options = { stage: 'rig' as const, route: chosen, mesh, prompt: 'robot', seed: 42, steps: 20,
      signal: AbortSignal.timeout(5000), progress: () => {}, submitted: () => {},
      record: async (record: AiProvenance) => { records.push(structuredClone(record)) } }
    await providers.execute(options)
    assert.deepEqual(calls.find(call => call.url.endsWith('/models/import'))?.body, { input: 'mesh_file' })
    assert.deepEqual(calls.find(call => call.url.endsWith('/animations/rig'))?.body,
      { input: 'import_task', model: chosen.model, rig_type: 'biped', out_format: 'glb', spec: 'tripo' })
    assert.deepEqual(records.at(-1)?.taskIds, ['import_task', 'output_task'])
    await providers.execute({ ...options, stage: 'texture' })
    assert.deepEqual(calls.find(call => call.url.endsWith('/models/texture'))?.body,
      { input: 'import_task', model: chosen.model, texture: true, pbr: true, texture_seed: 42, texture_prompt: { text: 'robot' } })
    running = true
    const controller = new AbortController()
    await assert.rejects(providers.execute({ ...options, signal: controller.signal, progress: message => {
      if (message.includes('paid task')) controller.abort()
    } }), /does not expose task cancellation.*incur charges/)
  })

  await t.test('native routed motion sends actual inline constraints and fetches scoped SOMA outputs without shared files', async t => {
    const root = await temp(t), providers = new AiProviders(root, () => settings)
    providers.confirm = async () => true
    const constraints = [{ frame_indices: [0, 59], rotations: [1, 0, 0, 0] }]
    let prompt: ReturnType<typeof bindWorkflow> = {}, id = ''
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
      const address = String(url)
      if (address.endsWith('/object_info')) return Response.json(Object.fromEntries(
        ['Studio_Kimodo_LoadLFM', 'Kimodo_TextEncode', 'Studio_Kimodo_Sampler', 'Kimodo_SaveNPZ', 'Kimodo_ExportBVH', 'Kimodo_Preview3D', 'Studio_MotionFile'].map(name => [name, {}])))
      if (address.endsWith('/prompt')) {
        const body = JSON.parse(String(options?.body)); prompt = body.prompt; id = body.prompt_id
        return Response.json({ prompt_id: id })
      }
      if (address.includes('/history/')) return Response.json({ [id]: { status: { completed: true, status_str: 'success' }, outputs: {
        '7': { files: [{ filename: prompt['4'].inputs.filename_prefix + '_0001.npz', subfolder: 'motion', type: 'output' }] },
        '8': { files: [{ filename: prompt['5'].inputs.filename_prefix + '_0001.bvh', subfolder: 'motion', type: 'output' }] },
        '6': { motion_json: [JSON.stringify({ num_joints: 77, num_frames: 60, fps: 30 })] }
      } } })
      assert.ok(address.includes('/view?'))
      return new Response('motion output fixture')
    })
    const request = { characterId: 'fixture', prompt: 'walk', seconds: 2, seed: 42, steps: 20, inPlace: false }
    const output = await providers.execute({
      stage: 'motion', route: { ...route('https://gpu.example', 'comfyui'), model: 'custom-motion' },
      ...request, constraints, textEncoder: 'lfm', native: parameters => motionProviderTemplate(request, parameters, 'lfm'),
      signal: AbortSignal.timeout(5000), progress: () => {}, submitted: () => {}, record: async () => {}
    })
    assert.deepEqual(JSON.parse(String(prompt['3'].inputs.constraints_json)), constraints)
    assert.equal(prompt['1'].class_type, 'Studio_Kimodo_LoadLFM')
    assert.equal(prompt['1'].inputs.model, 'custom-motion')
    assert.equal(output.metadata?.num_frames, 60)
    assert.ok(output.npz?.length && output.bvh?.length)
  })
  const result = await providers.execute({ stage: 'mesh', route: chosen, image, prompt: 'robot', seed: 42, steps: 20,
    signal: AbortSignal.timeout(5000), progress: () => {}, submitted: () => {}, record: async () => {} })
  assert.deepEqual(result.model, glb())
  assert.deepEqual(await providers.balance(chosen, AbortSignal.timeout(1000)), { balance: 100, frozen: 5 })
  assert.equal(calls.filter(call => call.options?.method === 'POST' && call.url.includes('/generation/')).length, 1)
  for (const call of calls.filter(call => call.url.startsWith(chosen.endpoint)))
    assert.equal(new Headers(call.options?.headers).get('Authorization'), 'Bearer test-only-tripo-key')
})
