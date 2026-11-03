import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Studio } from '../src/main/studio'
import { skinningSchema } from '../src/main/validation'
import { defaultLandmarks, turnModel } from '../src/shared/rig'
import type { Character, Vec3 } from '../src/shared/types'

test('model quarter-turns wrap every axis without changing the source or other angles', () => {
  for (const axis of [0, 1, 2] as const) {
    const source: Vec3 = [15, -30, 45]
    const before = [...source]
    let rotation = source
    for (let count = 0; count < 4; count++) {
      rotation = turnModel(rotation, axis, 90)
      assert.ok(rotation.every(angle => angle >= -180 && angle <= 180))
      for (const other of [0, 1, 2]) if (other !== axis) assert.equal(rotation[other], source[other])
    }
    assert.deepEqual(rotation, source)
    assert.deepEqual(source, before)
    assert.deepEqual(turnModel(turnModel(source, axis, -90), axis, 90), source)
    assert.deepEqual(turnModel(turnModel(source, axis, 180), axis, 180), source)
  }
  assert.deepEqual(turnModel([0, 180, 0], 1, 90), [0, -90, 0])
  assert.deepEqual(turnModel([0, -180, 0], 1, -90), [0, 90, 0])
})

test('saving model orientation persists it, invalidates the rig and preserves completed takes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-orientation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initial = new Studio(root, resolve('.')).snapshot()
  const character: Character = {
    id: randomUUID(), name: 'Orientation fixture', importedAt: new Date().toISOString(), previewUrl: '',
    vertices: 100, meshes: 1, warnings: [], rigged: true,
    setup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() }
  }
  const completed = { id: randomUUID(), characterId: character.id, characterName: character.name, kind: 'generate',
    stage: 'complete', message: 'Earlier take', progress: 100, createdAt: new Date().toISOString() }
  writeFileSync(join(root, 'studio.json'), JSON.stringify({
    ...initial, settings: { ...initial.settings, blenderPath: join(root, 'intentionally-missing-blender') },
    characters: [character], jobs: [completed]
  }))
  const studio = new Studio(root, resolve('.'))
  const completedBefore = studio.snapshot().jobs
  const setup = { ...character.setup, rotation: turnModel(character.setup.rotation, 2, -90) }
  const saved = studio.saveSetup(character.id, setup)
  assert.deepEqual(saved.setup, setup)
  assert.equal(saved.rigged, false)
  assert.equal(saved.rigPreviewUrl, undefined)
  assert.deepEqual(studio.snapshot().jobs, completedBefore)
  assert.deepEqual(new Studio(root, resolve('.')).snapshot().characters[0].setup, setup)
  await assert.rejects(studio.generate({ characterId: character.id, prompt: 'Walk forward.', seconds: 3, seed: 1, steps: 100, inPlace: false }), /validated rig/)
  await assert.rejects(studio.rig(character.id))
  const state = studio.snapshot()
  const request = JSON.parse(readFileSync(join(root, 'jobs', state.jobs[0].id, 'request-rig.json'), 'utf8'))
  assert.deepEqual(request.setup, setup, 'The backend receives the corrected orientation when rebuilding.')
  assert.deepEqual(state.jobs[1], completedBefore[0])
})

test('skinning is automatic by default; proximity fallback is explicit and validated', () => {
  assert.equal(skinningSchema.parse(undefined), 'automatic')
  assert.equal(skinningSchema.parse('fallback'), 'fallback')
  for (const value of [null, true, 'ignore-errors', {}, '']) assert.equal(skinningSchema.safeParse(value).success, false)
})

test('failed fallback preserves fitted points, prior completed work, and explicit request mode', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-rigging-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initial = new Studio(root, resolve('.')).snapshot()
  const character: Character = {
    id: randomUUID(), name: 'Test character', importedAt: new Date().toISOString(), previewUrl: '',
    vertices: 100, meshes: 1, warnings: [], rigged: false,
    setup: { rotation: [0, 90, 0], landmarks: defaultLandmarks() }
  }
  character.setup.landmarks.Head[2] = 0.12
  const completed = { id: randomUUID(), characterId: character.id, characterName: character.name, kind: 'rig',
    stage: 'complete', message: 'Earlier rig', progress: 100, createdAt: new Date().toISOString(), warnings: ['Earlier warning'] }
  writeFileSync(join(root, 'studio.json'), JSON.stringify({
    ...initial, settings: { ...initial.settings, blenderPath: join(root, 'intentionally-missing-blender') },
    characters: [character], jobs: [completed]
  }))
  const studio = new Studio(root, resolve('.'))
  await assert.rejects(studio.rig(character.id, false, 'fallback'))
  const state = studio.snapshot()
  assert.deepEqual(state.characters[0].setup, character.setup)
  assert.equal(state.characters[0].rigged, false)
  assert.equal(state.jobs[0].stage, 'failed')
  assert.deepEqual(state.jobs[1], completed)
  const request = JSON.parse(readFileSync(join(root, 'jobs', state.jobs[0].id, 'request-rig.json'), 'utf8'))
  assert.equal(request.skinning, 'fallback')
  assert.deepEqual(request.setup, character.setup)
  assert.deepEqual(new Studio(root, resolve('.')).snapshot().characters[0].setup, character.setup)
  await assert.rejects(studio.generate({ characterId: character.id, prompt: 'Walk forward.', seconds: 3, seed: 1, steps: 100, inPlace: false }), /validated rig/)
})
