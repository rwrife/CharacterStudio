import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Studio } from '../src/main/studio'
import { skinningSchema } from '../src/main/validation'
import { defaultLandmarks } from '../src/shared/rig'
import type { Character } from '../src/shared/types'

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
