import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Quaternion, Vector3 } from 'three'
import { defaultLandmarks } from '../src/shared/rig'
import { assertHandPoseFits, fingerChains, fingerRotation, fittingPoints, handLinks, handTemplate, openFingers } from '../src/shared/hand-rig'
import { handPoseSchema, setupSchema } from '../src/main/validation'
import type { HandPose, RigSetup } from '../src/shared/types'

const body = (): RigSetup => ({ rotation: [0, 0, 0], landmarks: defaultLandmarks() })
test('three-chain templates preserve body landmarks and support independent detail and hand-scale links', () => {
  const original = body()
  const setup = handTemplate(original, 'left', 'basic')
  assert.deepEqual(setupSchema.parse(setup), setup)
  assert.equal(setup.hands?.right.detail, 'wrist')
  assert.equal(handLinks(setup).length, 9)
  assert.equal(Object.keys(fittingPoints(setup)).length, Object.keys(original.landmarks).length + 12)
  for (const [name, point] of Object.entries(original.landmarks)) assert.deepEqual(setup.landmarks[name], point)
  assert.equal(original.hands, undefined)
  const both = handTemplate(setup, 'right', 'basic')
  for (const chain of ['Thumb', 'Index', 'Fingers']) {
    const [x, y, z] = both.landmarks[`Left${chain}1`]
    assert.deepEqual(both.landmarks[`Right${chain}1`], [-x, y, z])
  }
  const wrist = handTemplate(setup, 'left', 'wrist')
  assert.deepEqual(wrist.landmarks, original.landmarks)
  assert.equal(handLinks(wrist).length, 0)
})

test('hand fitting rejects missing chains, degenerate axes and invalid region radii', () => {
  const valid = handTemplate(body(), 'left', 'basic')
  for (const mutate of [
    (s: RigSetup) => { delete s.landmarks.LeftThumb2 },
    (s: RigSetup) => { s.landmarks.LeftIndex2 = s.landmarks.LeftIndex1 },
    (s: RigSetup) => { s.landmarks.LeftPalmNormal = s.landmarks.LeftHandEnd },
    (s: RigSetup) => { s.landmarks.LeftIndex2 = new Vector3(...s.landmarks.LeftIndex1).add(new Vector3(0, 0.02, 0)).toArray() },
    (s: RigSetup) => { s.landmarks.LeftIndex1 = s.landmarks.LeftHand; s.landmarks.LeftFingers1 = s.landmarks.LeftHand },
    (s: RigSetup) => { if (s.hands?.left.detail === 'basic') s.hands.left.thumbRadius = 0.001 }
  ]) {
    const invalid = structuredClone(valid); mutate(invalid)
    assert.equal(setupSchema.safeParse(invalid).success, false)
  }
  assert.equal(setupSchema.safeParse({ ...valid, hands: { left: { detail: 'individual' }, right: { detail: 'wrist' } } }).success, false)
})

test('finger controls are bounded and nonzero poses cannot silently target wrist-only hands', () => {
  const pose: HandPose = { version: 2, detail: 'basic', left: [0, 0, 0], right: [0, 0, 0],
    fingers: { left: { ...openFingers(), index: 0.8 }, right: openFingers() } }
  assert.deepEqual(handPoseSchema.parse(pose), pose)
  assert.throws(() => assertHandPoseFits(pose, body()), /no finger rig/)
  assert.doesNotThrow(() => assertHandPoseFits(pose, handTemplate(body(), 'left', 'basic')))
  assert.equal(handPoseSchema.safeParse({ ...pose, fingers: { ...pose.fingers, left: { ...pose.fingers.left, thumb: 1.01 } } }).success, false)
  assert.equal(handPoseSchema.safeParse({ ...pose, fingers: { ...pose.fingers, left: { ...pose.fingers.left, extra: 0 } } }).success, false)
})

test('curl bends toward the palm on both hands and opposition is mirrored', () => {
  for (const side of ['left', 'right'] as const) {
    const curl = fingerRotation(side, fingerChains[1], 0, { ...openFingers(), index: 1 })
    assert.ok(new Vector3(0, 1, 0).applyQuaternion(curl).z < -0.9)
  }
  const left = fingerRotation('left', fingerChains[0], 0, { ...openFingers(), opposition: 1 })
  const right = fingerRotation('right', fingerChains[0], 0, { ...openFingers(), opposition: 1 })
  assert.ok(left.clone().multiply(right).angleTo(fingerRotation('left', fingerChains[0], 0, openFingers())) < 1e-7)
  const tip = fingerRotation('left', fingerChains[1], 2, { ...openFingers(), index: 1 })
  assert.ok(tip.angleTo(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -55 * Math.PI / 180)) < 1e-7)
  assert.throws(() => fingerRotation('left', fingerChains[0], 2, openFingers()), /Invalid finger segment/)
})
