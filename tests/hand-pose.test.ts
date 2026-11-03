import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Euler, Quaternion, Vector3 } from 'three'
import { defaultHandPose, wristCorrection } from '../src/shared/hand-pose'
import { handTemplate, openFingers } from '../src/shared/hand-rig'
import { defaultLandmarks } from '../src/shared/rig'
import { handPoseSchema } from '../src/main/validation'
import { Studio } from '../src/main/studio'
import type { HandPose, Job } from '../src/shared/types'

test('hand pose defaults preserve old rigs and reject unsupported or malformed settings', () => {
  assert.deepEqual(handPoseSchema.parse(undefined), defaultHandPose())
  for (const invalid of [null, {}, { ...defaultHandPose(), version: 2 }, { ...defaultHandPose(), detail: 'basic' },
    { ...defaultHandPose(), left: [0, 0] }, { ...defaultHandPose(), right: [0, 0, 181] },
    { ...defaultHandPose(), left: [NaN, 0, 0] }, { ...defaultHandPose(), right: [Infinity, 0, 0] },
    { ...defaultHandPose(), script: 'ignored?' }, { ...defaultHandPose(), left: ['0', 0, 0] }])
    assert.equal(handPoseSchema.safeParse(invalid).success, false)
  const first = handPoseSchema.parse(undefined)
  first.left[0] = 45
  assert.equal(handPoseSchema.parse(undefined).left[0], 0)
})

test('wrist offsets use character rest axes, preserve identity, and do not accumulate', () => {
  const rest = new Quaternion().setFromEuler(new Euler(0.7, -0.3, 1.2))
  const original = rest.clone()
  assert.ok(wristCorrection([0, 0, 0], rest).angleTo(new Quaternion()) < 1e-7)
  const correction = wristCorrection([31, -42, 63], rest)
  const expected = new Quaternion().setFromEuler(new Euler(31 * Math.PI / 180, -42 * Math.PI / 180, 63 * Math.PI / 180))
  const posed = rest.clone().multiply(correction)
  assert.ok(posed.angleTo(expected.multiply(rest)) < 1e-7)
  assert.ok(rest.equals(original), 'The rest reference must never be mutated.')
  assert.deepEqual(wristCorrection([31, -42, 63], rest).toArray(), correction.toArray())
  assert.ok(new Vector3(1, 0, 0).applyQuaternion(posed).distanceTo(new Vector3(1, 0, 0).applyQuaternion(rest)) > 0.1)
})

function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'studio-hand-pose-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initial = new Studio(root, resolve('.')).snapshot()
  const target = {
    id: randomUUID(), name: 'Procedural hand fixture', importedAt: new Date().toISOString(),
    previewUrl: '', vertices: 24, meshes: 1, warnings: [], rigged: true,
    setup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() }, rigDirectory: join(root, 'existing-rig')
  }
  const prior: Job = {
    id: randomUUID(), characterId: target.id, characterName: target.name, kind: 'generate',
    stage: 'complete', message: 'Fixture', progress: 100, createdAt: new Date().toISOString(), inPlace: false
  }
  writeFileSync(join(root, 'studio.json'), JSON.stringify({ ...initial, characters: [target], jobs: [prior] }))
  const studio = new Studio(root, resolve('.'))
  t.after(() => studio.dispose())
  return { root, studio, target, prior: studio.snapshot().jobs[0] }
}

test('pose saves persist without touching rig, fit, original jobs or caller data', async t => {
  const { root, studio, target, prior } = fixture(t)
  const pose = defaultHandPose()
  pose.left = [30, -40, 50]
  const oldRig = studio.snapshot().characters[0].rigPreviewUrl
  const saved = studio.saveHandPose(target.id, pose)
  pose.left[0] = 0
  assert.equal(saved.handPose?.left[0], 30)
  assert.equal(saved.rigged, true)
  assert.equal(saved.rigPreviewUrl, oldRig)
  assert.deepEqual(saved.setup, target.setup)
  assert.deepEqual(studio.snapshot().jobs, [prior])
  const loaded = new Studio(root, resolve('.'))
  t.after(() => loaded.dispose())
  assert.deepEqual(loaded.snapshot().characters[0].handPose, saved.handPose)
  assert.throws(() => studio.saveHandPose(target.id, undefined))
  assert.throws(() => studio.saveHandPose(target.id, { ...saved.handPose, left: [999, 0, 0] }))
  assert.deepEqual(studio.snapshot().characters[0].handPose, saved.handPose)
  studio.saveSetup(target.id, saved.setup)
  assert.throws(() => studio.saveHandPose(target.id, defaultHandPose()), /validated rig/)
})

test('branching refuses hand pose changes before creating a job or contacting inference', async t => {
  const { studio, target, prior } = fixture(t)
  studio.saveHandPose(target.id, { ...defaultHandPose(), left: [0, 0, 45] })
  await assert.rejects(studio.generate({
    characterId: target.id, prompt: 'Walk ahead', seconds: 2, seed: 1, steps: 25, inPlace: false, parentJobId: prior.id
  }), /parent take's saved hand pose/)
  assert.deepEqual(studio.snapshot().jobs, [prior])
})

test('generation freezes pose into the job before asynchronous work', async t => {
  const { studio, target } = fixture(t)
  const pose = { ...defaultHandPose(), right: [10, 20, 30] } satisfies HandPose
  studio.saveHandPose(target.id, pose)
  studio.check = async () => {
    assert.throws(() => studio.saveHandPose(target.id, defaultHandPose()), /current job/)
    return [{ name: 'Fixture', status: 'blocked', detail: 'Intentional fixture preflight failure' }]
  }
  await assert.rejects(studio.generate({
    characterId: target.id, prompt: 'Walk ahead', seconds: 2, seed: 1, steps: 25, inPlace: false
  }), /Intentional fixture/)
  assert.deepEqual(studio.snapshot().jobs[0].handPose, pose)
})

test('fixed-grip exports require a completed baking job and an associated variation', async t => {
  const { root, studio, target, prior } = fixture(t)
  await assert.rejects(studio.bakeHandGrip(target.id), /Basic three-chain/)
  assert.deepEqual(studio.snapshot().jobs, [prior])
  const state = JSON.parse(readFileSync(join(root, 'studio.json'), 'utf8'))
  state.jobs[0].kind = 'rig'
  state.jobs[0].outputFiles = ['rigged.glb', '../studio.json']
  writeFileSync(join(root, 'studio.json'), JSON.stringify(state))
  const ordinary = new Studio(root, resolve('.'))
  t.after(() => ordinary.dispose())
  assert.throws(() => ordinary.output(prior.id, 'rigged.glb'), /validated completed output/)
  state.characters[0].fixedGrip = { sourceCharacterId: randomUUID(), jobId: prior.id, pose: defaultHandPose() }
  writeFileSync(join(root, 'studio.json'), JSON.stringify(state))
  const baked = new Studio(root, resolve('.'))
  t.after(() => baked.dispose())
  assert.equal(baked.output(prior.id, 'rigged.glb'), join(root, 'jobs', prior.id, 'rigged.glb'))
  assert.throws(() => baked.output(prior.id, '../studio.json'), /validated completed output/)
})

test('finger poses persist independently and reducing rig detail clears only that hand', async t => {
  const { root, studio, target } = fixture(t)
  const state = JSON.parse(readFileSync(join(root, 'studio.json'), 'utf8'))
  state.characters[0].setup = handTemplate(handTemplate(state.characters[0].setup, 'left', 'basic'), 'right', 'basic')
  writeFileSync(join(root, 'studio.json'), JSON.stringify(state))
  const hands = new Studio(root, resolve('.'))
  t.after(() => hands.dispose())
  const pose: HandPose = { version: 2, detail: 'basic', left: [10, 0, 0], right: [0, 0, 0],
    fingers: { left: { ...openFingers(), index: 1 }, right: { ...openFingers(), thumb: 0.6 } } }
  hands.saveHandPose(target.id, pose)
  assert.deepEqual(hands.snapshot().characters[0].handPose, pose)
  const updated = hands.saveSetup(target.id, handTemplate(state.characters[0].setup, 'left', 'wrist'))
  assert.equal(updated.rigged, false)
  assert.equal(updated.handPose?.version, 2)
  if (updated.handPose?.version === 2) {
    assert.deepEqual(updated.handPose.fingers.left, openFingers())
    assert.deepEqual(updated.handPose.fingers.right, pose.fingers.right)
    assert.deepEqual(updated.handPose.left, pose.left)
  }
  assert.deepEqual(hands.snapshot().jobs, studio.snapshot().jobs)
})

test('batch reruns retain per-character hand poses; legacy batches use zero offsets', async t => {
  const { root, studio, target } = fixture(t)
  const pose = { ...defaultHandPose(), left: [10, 20, -30] } satisfies HandPose
  studio.saveHandPose(target.id, pose)
  const nodeId = randomUUID()
  const plan = studio.savePlan({
    id: randomUUID(), name: 'Hand snapshot fixture', graphVersion: 2, rigSetup: studio.snapshot().characters[0].setup,
    nodes: [{ id: nodeId, label: 'Idle', prompt: 'Stand still', seconds: 2, seed: 1, steps: 25, inPlace: false,
      kind: 'state', loop: false, stance: '', position: { x: 0, y: 0 } }],
    edges: [], entryNodeIds: [nodeId]
  })
  studio.check = async () => []
  const observed: (HandPose | undefined)[] = []
  studio.generate = async (request, batch) => {
    observed.push(batch?.handPose)
    assert.throws(() => studio.saveHandPose(target.id, defaultHandPose()), /current job/)
    return { id: randomUUID(), characterId: request.characterId, characterName: target.name,
      kind: 'generate', stage: 'complete', message: 'Fixture', progress: 100, createdAt: new Date().toISOString() }
  }
  await studio.runBatch({ planId: plan.id, characterIds: [target.id], seedStride: 0, autoRig: false })
  const batch = studio.snapshot().batches[0]
  studio.saveHandPose(target.id, { ...defaultHandPose(), left: [-60, 0, 0] })
  await studio.rerunBatch(batch.id)
  assert.ok(observed.length >= 2)
  assert.ok(observed.every(value => JSON.stringify(value) === JSON.stringify(pose)))
  assert.deepEqual(studio.snapshot().batches.at(-1), batch)
  const state = JSON.parse(readFileSync(join(root, 'studio.json'), 'utf8'))
  delete state.batches[0].handPoses
  writeFileSync(join(root, 'studio.json'), JSON.stringify(state))
  const legacy = new Studio(root, resolve('.'))
  t.after(() => legacy.dispose())
  legacy.check = async () => []
  legacy.generate = async (request, context) => {
    assert.deepEqual(context?.handPose, defaultHandPose())
    return { id: randomUUID(), characterId: request.characterId, characterName: target.name,
      kind: 'generate', stage: 'complete', message: 'Fixture', progress: 100, createdAt: new Date().toISOString() }
  }
  await legacy.rerunBatch(state.batches[0].id)
  state.batches[0].handPoses = {}
  writeFileSync(join(root, 'studio.json'), JSON.stringify(state))
  const broken = new Studio(root, resolve('.'))
  t.after(() => broken.dispose())
  await assert.rejects(broken.rerunBatch(state.batches[0].id), /missing a character hand pose/)
  studio.saveSetup(target.id, handTemplate(studio.snapshot().characters[0].setup, 'left', 'basic'))
  await assert.rejects(studio.rerunBatch(batch.id), /original hand fitting and rig detail/)
})
