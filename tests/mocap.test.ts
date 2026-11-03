import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultLandmarks } from '../src/shared/rig'
import { HEAD_PITCH, MOCAP_BONES, POSE, defaultMocapOptions, fillGaps, qrotate, solveMocap, type MocapCapture, type PoseFrame } from '../src/shared/mocap'
import type { Landmarks, Vec3 } from '../src/shared/types'

type V = [number, number, number]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const unit = (a: V): V => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] }
const yaw = (a: V, angle: number): V => [a[0] * Math.cos(angle) + a[2] * Math.sin(angle), a[1], -a[0] * Math.sin(angle) + a[2] * Math.cos(angle)]

/** Character-space pose points (keyed by rig landmark) turned into a MediaPipe world-landmark frame. */
function frame(points: Landmarks, visibility = 1, transform: (v: V) => V = v => v): PoseFrame {
  const P = (name: string) => points[name] as V
  const out: V[] = Array.from({ length: 33 }, () => P('Hips'))
  const set = (i: number, v: V) => { out[i] = v }
  set(POSE.nose, add(P('Head'), [0, 0, 0.1]))
  const rise = 0.08 * Math.tan(HEAD_PITCH)
  set(POSE.leftEye, add(P('Head'), [0.03, rise, 0.08])); set(POSE.rightEye, add(P('Head'), [-0.03, rise, 0.08]))
  set(POSE.leftEar, add(P('Head'), [0.07, 0, 0])); set(POSE.rightEar, add(P('Head'), [-0.07, 0, 0]))
  for (const [side, s] of [['Left', 0], ['Right', 1]] as const) {
    set(POSE.leftShoulder + s, P(`${side}Arm`)); set(POSE.leftElbow + s, P(`${side}ForeArm`)); set(POSE.leftWrist + s, P(`${side}Hand`))
    set(POSE.leftIndex + s, add(P(`${side}HandEnd`), [0, 0, 0.03])); set(POSE.leftPinky + s, add(P(`${side}HandEnd`), [0, 0, -0.03]))
    set(POSE.leftHip + s, P(`${side}Leg`)); set(POSE.leftKnee + s, P(`${side}Shin`)); set(POSE.leftAnkle + s, P(`${side}Foot`))
    set(POSE.leftHeel + s, add(P(`${side}Foot`), [0, -0.06, -0.05])); set(POSE.leftFootIndex + s, P(`${side}ToeBase`))
  }
  const hips = transform(P('Hips'))
  return out.map(v => { const t = sub(transform(v), hips); return [t[0], -t[1], -t[2], visibility] })
}
const capture = (frames: PoseFrame[]): MocapCapture => ({ version: 1, model: 'lite', fps: 30, width: 640, height: 480, frames })
const angle = (a: V, b: V) => Math.acos(Math.min(1, Math.max(-1, unit(a)[0] * unit(b)[0] + unit(a)[1] * unit(b)[1] + unit(a)[2] * unit(b)[2])))
const rotation = (motion: ReturnType<typeof solveMocap>, frameIndex: number, bone: string) => motion.rotations[frameIndex][motion.bones.indexOf(bone)]
const rest = defaultLandmarks()
const restDir = (from: string, to: string) => sub(rest[to] as V, rest[from] as V)

test('rest pose observations solve to identity rotations and no hip offset', () => {
  const motion = solveMocap(capture([frame(rest), frame(rest), frame(rest)]), rest, defaultMocapOptions())
  assert.deepEqual(motion.bones, MOCAP_BONES)
  assert.equal(motion.frames, 3)
  assert.equal(motion.legs, 'tracked')
  for (const row of motion.rotations) for (const q of row) assert.ok(Math.abs(q[0]) > 0.999, `expected identity, got ${q}`)
  for (const h of motion.hips) assert.ok(Math.abs(h[1]) < 1e-6)
})

test('a whole-body turn is carried by every tracked bone', () => {
  const turn = Math.PI / 2
  const motion = solveMocap(capture([frame(rest, 1, v => yaw(v, turn)), frame(rest, 1, v => yaw(v, turn))]), rest, { ...defaultMocapOptions(), smoothing: 0 })
  for (const bone of ['Hips', 'Chest', 'Head', 'LeftArm', 'RightShin']) {
    const forward = qrotate(rotation(motion, 1, bone), [0, 0, 1])
    assert.ok(angle(forward, [1, 0, 0]) < 0.02, `${bone} should face +X after the turn, got ${forward}`)
  }
})

test('an elbow bend rotates the forearm and keeps the upper arm', () => {
  const bent: Landmarks = { ...rest, LeftHand: add(rest.LeftForeArm as V, [0, 0, 0.29]) as Vec3, LeftHandEnd: add(rest.LeftForeArm as V, [0, 0, 0.45]) as Vec3 }
  const motion = solveMocap(capture([frame(bent), frame(bent)]), rest, { ...defaultMocapOptions(), smoothing: 0 })
  const forearm = qrotate(rotation(motion, 1, 'LeftForeArm'), restDir('LeftForeArm', 'LeftHand'))
  assert.ok(angle(forearm, [0, 0, 1]) < 0.02, `forearm should point forward, got ${forearm}`)
  const upper = qrotate(rotation(motion, 1, 'LeftArm'), restDir('LeftArm', 'LeftForeArm'))
  assert.ok(angle(upper, restDir('LeftArm', 'LeftForeArm')) < 0.02)
  const hand = qrotate(rotation(motion, 1, 'LeftHand'), restDir('LeftHand', 'LeftHandEnd'))
  assert.ok(angle(hand, [0, 0, 1]) < 0.05)
})

test('a raised arm moves the matching side, or the opposite side when mirrored', () => {
  const raised: Landmarks = { ...rest, LeftForeArm: add(rest.LeftArm as V, [0, 0.3, 0]) as Vec3, LeftHand: add(rest.LeftArm as V, [0, 0.59, 0]) as Vec3, LeftHandEnd: add(rest.LeftArm as V, [0, 0.75, 0]) as Vec3 }
  const frames = [frame(raised), frame(raised)]
  const direct = solveMocap(capture(frames), rest, { ...defaultMocapOptions(), smoothing: 0 })
  assert.ok(angle(qrotate(rotation(direct, 1, 'LeftArm'), restDir('LeftArm', 'LeftForeArm')), [0, 1, 0]) < 0.02)
  assert.ok(Math.abs(rotation(direct, 1, 'RightArm')[0]) > 0.999)
  const mirrored = solveMocap(capture(frames), rest, { ...defaultMocapOptions(), smoothing: 0, mirror: true })
  assert.ok(angle(qrotate(rotation(mirrored, 1, 'RightArm'), restDir('RightArm', 'RightForeArm')), [0, 1, 0]) < 0.02)
  assert.ok(Math.abs(rotation(mirrored, 1, 'LeftArm')[0]) > 0.999)
  assert.ok(mirrored.warnings.some(w => w.includes('mirrored')))
})

test('crouching lowers the hips relative to the standing reference', () => {
  const crouch: Landmarks = Object.fromEntries(Object.entries(rest).map(([name, p]) => [name, /Foot|Toe/.test(name) ? [p[0], p[1] + 0.4, p[2]] : p])) as Landmarks
  const frames = [...Array.from({ length: 20 }, () => frame(rest)), ...Array.from({ length: 5 }, () => frame(crouch))]
  const motion = solveMocap(capture(frames), rest, { ...defaultMocapOptions(), smoothing: 0 })
  assert.ok(Math.abs(motion.hips[0][1]) < 1e-6)
  assert.ok(motion.hips[24][1] < -0.2, `expected lowered hips, got ${motion.hips[24][1]}`)
  const flat = solveMocap(capture(frames), rest, { ...defaultMocapOptions(), smoothing: 0, hipHeight: false })
  assert.ok(flat.hips.every(h => h[1] === 0))
})

test('legs lock automatically when knees and ankles are not visible', () => {
  const hidden = frame(rest)!.map((p, i) => i >= 25 ? [p[0], p[1], p[2], 0.1] : p) as PoseFrame
  const motion = solveMocap(capture([hidden, hidden]), rest, defaultMocapOptions())
  assert.equal(motion.legs, 'locked')
  assert.ok(motion.warnings.some(w => w.includes('locked')))
  const tracked = solveMocap(capture([hidden, hidden]), rest, { ...defaultMocapOptions(), legs: 'track' })
  assert.equal(tracked.legs, 'tracked')
})

test('gaps are interpolated and mostly-empty takes are rejected', () => {
  const a = frame(rest)!, b = frame(rest, 1, v => add(v, [0, 0, 0]))!.map(p => [p[0] + 0.2, p[1], p[2], 1]) as PoseFrame
  const filled = fillGaps([null, a, null, b, null])
  assert.equal(filled.detected, 2)
  assert.ok(Math.abs(filled.points[2][0][0] - (a![0][0] + 0.1)) < 1e-9)
  assert.equal(filled.points[0][0][0], a![0][0])
  assert.equal(filled.points[4][0][0], b![0][0])
  assert.throws(() => solveMocap(capture([frame(rest), null, null, null]), rest, defaultMocapOptions()), /detected in only 1 of 4/)
  assert.throws(() => solveMocap(capture([null, null]), rest, defaultMocapOptions()), /No person/)
})
