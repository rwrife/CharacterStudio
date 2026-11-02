import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { enclosedPoints, fitLandmarks, LandmarkFitError, orientGeometry } from '../src/shared/landmark-fit'
import { readGlbGeometry } from '../src/main/mesh-geometry'
import { Studio } from '../src/main/studio'
import { setupSchema } from '../src/main/validation'
import { defaultLandmarks } from '../src/shared/rig'
import type { Character, Vec3 } from '../src/shared/types'
import { boxHumanoid, boxMesh, encodeGlb } from './fixtures/humanoid-mesh'

const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`)

test('auto-fit places every humanoid landmark inside a procedural T-pose body', () => {
  const mesh = boxHumanoid()
  const fit = fitLandmarks(mesh, [0, 0, 0])
  const { landmarks } = fit
  assert.deepEqual(Object.keys(landmarks).sort(), Object.keys(defaultLandmarks()).sort())
  assert.deepEqual(fit.warnings, [])
  assert.deepEqual(fit.outside, [])
  assert.equal(setupSchema.safeParse({ rotation: [0, 0, 0], landmarks }).success, true)
  assert.ok(enclosedPoints(orientGeometry(mesh, [0, 0, 0]), mesh.indices, Object.values(landmarks)).every(Boolean))
  // Rig normalization centres depth on the bounding box (back -0.12, toes +0.2), so the body midline is z = -0.04.
  for (const [side, s] of [['Left', 1], ['Right', -1]] as const) {
    near(landmarks[`${side}Arm`][0], s * 0.2, 0.03, `${side}Arm x`)
    near(landmarks[`${side}Arm`][1], 1.5, 0.04, `${side}Arm y`)
    near(landmarks[`${side}Hand`][0], s * 0.74, 0.05, `${side}Hand x`)
    near(landmarks[`${side}HandEnd`][0], s * 0.89, 0.04, `${side}HandEnd x`)
    near(landmarks[`${side}Leg`][0], s * 0.12, 0.03, `${side}Leg x`)
    near(landmarks[`${side}Foot`][1], 0.12, 0.05, `${side}Foot y`)
    near(landmarks[`${side}Foot`][2], -0.04, 0.03, `${side}Foot z`)
    assert.ok(landmarks[`${side}ToeEnd`][2] > landmarks[`${side}Foot`][2] + 0.1, `${side} toes point forward`)
    assert.ok(landmarks[`${side}Shin`][1] < landmarks[`${side}Leg`][1] && landmarks[`${side}Shin`][1] > landmarks[`${side}Foot`][1])
  }
  near(landmarks.Hips[1], 1, 0.08, 'Hips y')
  near(landmarks.Hips[2], -0.04, 0.03, 'Hips z')
  assert.ok(landmarks.Neck1[1] > landmarks.Chest[1] && landmarks.Neck1[1] < 1.72)
  assert.ok(landmarks.Head[1] > 1.6 && landmarks.HeadEnd[1] < 2)
})

test('auto-fit applies the setup rotation and is independent of mesh units and placement', () => {
  const mesh = boxHumanoid()
  const expected = fitLandmarks(mesh, [0, 0, 0]).landmarks
  // Facing +X in the source; the setup rotation Y -90 turns it to face +Z.
  const sideways = new Float32Array(mesh.positions.length)
  for (let i = 0; i < sideways.length; i += 3) {
    sideways[i] = mesh.positions[i + 2]; sideways[i + 1] = mesh.positions[i + 1]; sideways[i + 2] = -mesh.positions[i]
  }
  const centimetres = mesh.positions.map((value, i) => value * 100 + [50, 7, -20][i % 3])
  for (const [positions, rotation] of [[sideways, [0, -90, 0]], [centimetres, [0, 0, 0]]] as [Float32Array, Vec3][]) {
    const actual = fitLandmarks({ positions, indices: mesh.indices }, rotation).landmarks
    for (const name of Object.keys(expected)) for (let axis = 0; axis < 3; axis++)
      near(actual[name][axis], expected[name][axis], 0.015, `${name}[${axis}] with rotation ${rotation}`)
  }
})

test('auto-fit refuses shapes it cannot read as a standing humanoid', () => {
  assert.throws(() => fitLandmarks(boxMesh([[-0.3, 0, -0.2, 0.3, 2, 0.2]]), [0, 0, 0]), LandmarkFitError)
  const armsDown = boxMesh([[-0.25, 0.9, -0.12, 0.25, 1.6, 0.12], [-0.1, 1.6, -0.1, 0.1, 2, 0.1], [0.04, 0, -0.07, 0.2, 0.95, 0.07], [-0.2, 0, -0.07, -0.04, 0.95, 0.07]])
  assert.throws(() => fitLandmarks(armsDown, [0, 0, 0]), LandmarkFitError)
  assert.throws(() => fitLandmarks({ positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }, [0, 0, 0]), LandmarkFitError)
  assert.throws(() => fitLandmarks({ positions: new Float32Array(0), indices: new Uint32Array(0) }, [0, 0, 0]), LandmarkFitError)
})

test('GLB geometry reader applies node transforms and rejects incomplete files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-mesh-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mesh = boxHumanoid()
  const file = join(root, 'scaled.glb')
  writeFileSync(file, encodeGlb({ positions: mesh.positions.map((value, i) => value * 100 - [0, 0, 300][i % 3]), indices: mesh.indices }, { scale: 0.01, translation: [0, 0, 3] }, 'u16'))
  const geometry = await readGlbGeometry(file)
  assert.deepEqual(Array.from(geometry.indices), Array.from(mesh.indices))
  geometry.positions.forEach((value, i) => near(value, mesh.positions[i], 1e-5, `position ${i}`))
  const bytes = encodeGlb(mesh)
  writeFileSync(file, bytes.subarray(0, bytes.length - 40))
  await assert.rejects(readGlbGeometry(file), /complete binary glTF/)
  writeFileSync(file, Buffer.from('not a mesh'))
  await assert.rejects(readGlbGeometry(file), /complete binary glTF/)
})

test('studio auto-fit reads the stored preview and validates its arguments', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-autofit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initial = new Studio(root, resolve('.')).snapshot()
  const character: Character = {
    id: randomUUID(), name: 'Procedural humanoid', importedAt: new Date().toISOString(), previewUrl: '',
    vertices: 0, meshes: 1, warnings: [], rigged: false, setup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() }
  }
  mkdirSync(join(root, 'characters', character.id), { recursive: true })
  writeFileSync(join(root, 'characters', character.id, 'preview.glb'), encodeGlb(boxHumanoid()))
  writeFileSync(join(root, 'studio.json'), JSON.stringify({ ...initial, characters: [character] }))
  const studio = new Studio(root, resolve('.'))
  const fit = await studio.fitLandmarks(character.id, [0, 0, 0])
  assert.deepEqual(fit.landmarks, fitLandmarks(boxHumanoid(), [0, 0, 0]).landmarks)
  assert.deepEqual(studio.snapshot().characters[0].setup, character.setup, 'Auto-fit only suggests landmarks; saving stays explicit.')
  await assert.rejects(studio.fitLandmarks(randomUUID(), [0, 0, 0]), /Character not found/)
  await assert.rejects(studio.fitLandmarks(character.id, [0, 400, 0] as Vec3))
  writeFileSync(join(root, 'characters', character.id, 'preview.glb'), encodeGlb(boxMesh([[-0.3, 0, -0.2, 0.3, 2, 0.2]])))
  await assert.rejects(studio.fitLandmarks(character.id, [0, 0, 0]), LandmarkFitError)
})
