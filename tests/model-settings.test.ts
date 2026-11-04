import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiProviders } from '../src/main/ai-providers'
import { Studio } from '../src/main/studio'
import { designConfigSchema } from '../src/main/designer'
import { defaultAiConfiguration, localRoute, type AiHardware } from '../src/shared/ai'
import { memoryGuidance, nativeTaskSummary, recommendedDesignerConfig, recommendedTaskSetup } from '../src/shared/model-settings'

const native = designConfigSchema.parse({
  imageProfile: 'sdxl', checkpoint: 'saved-custom.safetensors', controlnet: 'saved-control',
  meshProfile: 'textured', meshCheckpoint: 'saved-mesh', titleModel: 'saved-title',
  editModel: 'saved-edit', backgroundModel: 'saved-background', meshFaceCount: 150000
})

test('new installations use supported recommended setups without rewriting existing saved configurations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-default-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fresh = new Studio(root, root)
  assert.deepEqual(fresh.snapshot().designer?.config, designConfigSchema.parse(recommendedDesignerConfig))
  assert.equal(fresh.snapshot().settings.textEncoder, 'llm2vec')
  for (const stage of ['scene', 'tpose', 'cutout', 'mesh'] as const) {
    const reset = recommendedTaskSetup(defaultAiConfiguration, fresh.snapshot().designer!.config, stage)
    assert.deepEqual(reset.native, fresh.snapshot().designer!.config, `Fresh ${stage} already matches its recommendation.`)
  }
  const legacy = { ...native, meshProfile: 'mini' as const, meshCheckpoint: 'saved-mini.safetensors' }
  fresh.designer.saveSettings(legacy)
  const restored = new Studio(root, root)
  assert.deepEqual(restored.snapshot().designer?.config, legacy)
})

test('recommended setup changes only current task and preserves unrelated routes and model settings', () => {
  const remote = { provider: 'api' as const, location: 'remote' as const, endpoint: 'https://gateway.example', model: 'saved-model', minVramGB: 0 }
  const ai = { ...defaultAiConfiguration, globalComfy: { ...remote, provider: 'comfyui' as const, model: '' }, stages: { scene: remote, mesh: remote } }
  const original = structuredClone({ ai, native })
  const next = recommendedTaskSetup(ai, native, 'scene')
  assert.deepEqual(next.ai.stages.scene, localRoute)
  assert.deepEqual(next.ai.stages.mesh, remote)
  assert.deepEqual(next.ai.globalComfy, ai.globalComfy)
  assert.equal(next.native?.imageProfile, 'sd15')
  assert.equal(next.native?.checkpoint, 'DreamShaper_8_pruned.safetensors')
  assert.equal(next.native?.meshProfile, 'textured')
  assert.equal(next.native?.editModel, 'saved-edit')
  assert.equal(next.native?.titleModel, 'saved-title')
  assert.deepEqual({ ai, native }, original, 'Recommendation helpers never mutate their input.')
  const mesh = recommendedTaskSetup(ai, native, 'mesh')
  assert.equal(mesh.native?.meshProfile, 'standard')
  assert.equal(mesh.native?.meshCheckpoint, 'hunyuan3d-dit-v2_fp16.safetensors')
  assert.equal(mesh.native?.checkpoint, native.checkpoint)
  assert.equal(mesh.native?.meshFaceCount, native.meshFaceCount)
  const edit = recommendedTaskSetup(ai, native, 'tpose')
  assert.equal(edit.native?.backgroundModel, 'saved-background', 'Cutout remains an independent task.')
})

test('motion summary never substitutes a saved experimental encoder or invents its memory minimum', () => {
  assert.match(nativeTaskSummary('motion', native, 'lfm').name, /experimental/)
  assert.equal(nativeTaskSummary('motion', native, 'lfm').gb, undefined)
  assert.equal(nativeTaskSummary('motion', native, 'llm2vec').gb, 24)
  assert.equal(nativeTaskSummary('capture', native, 'llm2vec').gb, undefined)
  assert.match(nativeTaskSummary('capture', native, 'llm2vec').purpose, /CPU/)
})

test('memory guidance handles unknown, invalid, low and multiple GPU memory without pooling', () => {
  const hardware = (devices: AiHardware['devices']): AiHardware => ({ platform: 'test', architecture: 'arm64', cpu: 'fixture', ramGB: 32, freeRamGB: 20, devices })
  assert.match(memoryGuidance(undefined, 8), /unknown/)
  assert.match(memoryGuidance(hardware([]), 8), /unknown/)
  for (const freeGB of [NaN, Infinity, -1, 25])
    assert.match(memoryGuidance(hardware([{ name: 'invalid', type: 'cuda', freeGB, totalGB: 24 }]), 8), /unknown/)
  assert.match(memoryGuidance(hardware([{ name: 'zero', type: 'cuda', freeGB: 0, totalGB: 0 }]), 8), /unknown/)
  assert.match(memoryGuidance(hardware([{ name: 'A', type: 'cuda', freeGB: 6, totalGB: 8 }, { name: 'B', type: 'cuda', freeGB: 6, totalGB: 8 }]), 10), /Below/)
  for (const type of ['mps', 'xpu', 'directml', 'unknown', undefined])
    assert.match(memoryGuidance(hardware([{ name: 'Unified memory', type, freeGB: 32, totalGB: 64 }]), 10), /shared\/unified/)
  assert.match(memoryGuidance(hardware([{ name: 'Discrete GPU', type: 'cuda', freeGB: 16, totalGB: 24 }]), 10), /compatibility still needs checking/)
})

test('hardware reports real host measurements and honest disconnected, CPU-only and invalid backend states', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-hardware-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const providers = new AiProviders(root, () => ({ comfyUrl: 'http://127.0.0.1:1', comfyRoot: 'unused', comfyOutput: 'unused', blenderPath: 'unused' }))
  let response: unknown = { devices: [] }
  let disconnected = false
  t.mock.method(globalThis, 'fetch', async () => {
    if (disconnected) throw new Error('Backend disconnected')
    return Response.json(response)
  })
  const gib = 2 ** 30
  for (const devices of [
    [], [{ name: 'CPU', type: 'cpu', vram_total: 32 * gib, vram_free: 24 * gib }],
    [{ name: 'invalid', type: 'cuda', vram_total: 4 * gib, vram_free: 8 * gib }],
    [{ name: 'missing values', type: 'cuda' }]
  ]) {
    response = { devices }
    const result = await providers.hardware()
    assert.deepEqual(result.devices, [])
    assert.ok(result.warning)
    assert.ok(result.cpu && result.platform && result.architecture)
    assert.ok(result.ramGB > 0 && result.freeRamGB >= 0)
  }
  response = { devices: [{ name: 'A', type: 'cuda', vram_total: 8 * gib, vram_free: 6 * gib },
    { name: 'B', type: 'cuda', vram_total: 8 * gib, vram_free: 6 * gib }] }
  const two = await providers.hardware()
  assert.equal(two.devices.length, 2)
  assert.equal(two.devices[0].type, 'cuda')
  assert.equal(two.devices[0].freeGB, 6)
  assert.match(memoryGuidance(two, 10), /Below/)
  response = { devices: [{ name: 'Unified device', type: 'MPS', vram_total: 64 * gib, vram_free: 48 * gib }] }
  const unified = await providers.hardware()
  assert.equal(unified.devices[0].type, 'mps')
  assert.equal(unified.devices[0].freeGB, 48, 'Actual reported memory remains available for display.')
  assert.match(memoryGuidance(unified, 10), /shared\/unified/)
  disconnected = true
  const offline = await providers.hardware()
  assert.deepEqual(offline.devices, [])
  assert.match(offline.warning!, /unavailable/)
})
