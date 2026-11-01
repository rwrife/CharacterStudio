import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localUrl, generateSchema, setupSchema, settingsSchema } from '../src/main/validation'
import { defaultLandmarks } from '../src/shared/rig'
import { buildPrompt } from '../src/main/comfy'
import { Studio } from '../src/main/studio'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const request = { characterId: '0f58ac73-6a7e-4a04-81cc-b80ed5e8ceec', prompt: 'A person walks.', seconds: 5, seed: 42, steps: 100, inPlace: false }
test('only loopback ComfyUI origins are allowed', () => {
  assert.equal(localUrl('http://127.0.0.1:8189/'), 'http://127.0.0.1:8189')
  assert.equal(localUrl('http://localhost:8188'), 'http://localhost:8188')
  for (const url of ['https://example.com', 'http://192.168.1.1', 'http://127.0.0.1.evil.test', 'file:///C:/private', 'http://user:pass@localhost:8189', 'http://localhost:8189/upload', 'http://localhost:8189?to=remote'])
    assert.throws(() => localUrl(url))
})
test('workflow uses native API node objects and retains user parameters', () => {
  const graph = buildPrompt(request, 'studio_unique')
  assert.equal(graph['1'].inputs.model, 'Kimodo-SOMA-RP-v1')
  assert.equal(graph['2'].inputs.prompt, request.prompt)
  assert.equal(graph['3'].inputs.duration, 5)
  assert.equal(graph['3'].inputs.seed, 42)
  assert.equal(graph['3'].inputs.diffusion_steps, 100)
  assert.equal(graph['3'].inputs.num_samples, 1)
  assert.deepEqual(graph['4'].inputs.motion, ['3', 0])
  assert.equal(graph['5'].inputs.filename_prefix, 'studio_unique')
  assert.equal(Object.keys(graph).length, 6)
})
test('LFM changes only the loader and preserves pose constraints and original sampling nodes', () => {
  const original = buildPrompt(request, 'lfm-test', 'C:\\constraints.json')
  const lfm = buildPrompt(request, 'lfm-test', 'C:\\constraints.json', 'lfm')
  assert.equal(original['1'].class_type, 'Kimodo_LoadModel')
  assert.equal(lfm['1'].class_type, 'Studio_Kimodo_LoadLFM')
  assert.deepEqual(lfm['1'].inputs, original['1'].inputs)
  for (const key of ['2', '3', '4', '5', '6']) assert.deepEqual(lfm[key], original[key])
})
test('legacy backend settings retain Llama; LFM is explicit and validated', () => {
  const settings = { comfyUrl: 'http://127.0.0.1:8189', comfyRoot: 'C:\\ComfyUI', comfyOutput: 'C:\\ComfyUI\\output', blenderPath: 'C:\\blender.exe' }
  assert.equal(settingsSchema.parse(settings).textEncoder, 'llm2vec')
  assert.equal(settingsSchema.parse({ ...settings, textEncoder: 'lfm' }).textEncoder, 'lfm')
  assert.equal(settingsSchema.safeParse({ ...settings, textEncoder: 'remote' }).success, false)
})
test('reject invalid motion settings and excessive combined duration', () => {
  assert.deepEqual(generateSchema.parse(request), request)
  for (const patch of [{ prompt: ' ' }, { seconds: NaN }, { seconds: 31 }, { seed: -1 }, { seed: 1.2 }, { steps: 5 }, { prompt: 'One. Two. Three.', seconds: 30 }])
    assert.equal(generateSchema.safeParse({ ...request, ...patch }).success, false)
})
test('rig validates all landmarks, finite coordinates, and nonzero bones', () => {
  const setup = { rotation: [0, 90, 0], landmarks: defaultLandmarks() }
  assert.equal(setupSchema.safeParse(setup).success, true)
  setup.landmarks.HeadEnd = setup.landmarks.Head
  assert.equal(setupSchema.safeParse(setup).success, false)
  delete setup.landmarks.LeftArm
  assert.equal(setupSchema.safeParse(setup).success, false)
})
test('no completed output can be claimed for an input, absent job, or arbitrary path', () => {
  const studio = new Studio(mkdtempSync(join(tmpdir(), 'kimodo-unit-')), resolve('.'))
  assert.throws(() => studio.output('missing', '..\\private'))
  assert.throws(() => studio.saveSetup('missing', { rotation: [0, 0, 0], landmarks: defaultLandmarks() }))
})
