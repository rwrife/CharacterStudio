import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerValuesAt, handTimeline, poseAt, sameHandPose } from '../src/shared/hand-animation'
import { handPoseSchema, handTimelineSchema } from '../src/main/validation'
import { defaultHandPose } from '../src/shared/hand-pose'
import { assertHandPoseFits, openFingers } from '../src/shared/hand-rig'
import { defaultLandmarks } from '../src/shared/rig'
import type { HandPose } from '../src/shared/types'

const open = { left: openFingers(), right: openFingers() }
const closed = { left: { thumb: 1, index: 1, fingers: 1, opposition: 0.6 }, right: openFingers() }
const wave = (): Extract<HandPose, { version: 2 }> => ({ version: 2, detail: 'basic', left: [0, 0, 0], right: [0, 0, 0],
  fingers: open, keyframes: [{ time: 0, fingers: open }, { time: 0.5, fingers: closed }, { time: 1, fingers: open }] })

test('hand keys interpolate deterministically and preserve matching loop endpoints', () => {
  const pose = wave(), before = structuredClone(pose)
  assert.equal(fingerValuesAt(pose, 0.25).left.index, 0.5)
  assert.deepEqual(fingerValuesAt(pose, 0.5), closed)
  assert.ok(sameHandPose(poseAt(pose, 0), poseAt(pose, 1)))
  assert.deepEqual(pose, before)
  assert.throws(() => fingerValuesAt(pose, NaN), /preview time/)
  assert.throws(() => assertHandPoseFits(pose, { rotation: [0, 0, 0], landmarks: defaultLandmarks() }), /no finger rig/)
})

test('hand keys reject malformed times, missing endpoints and excessive keys', () => {
  for (const keys of [[], [{ time: 0, fingers: open }], [{ time: 0, fingers: open }, { time: 0, fingers: closed }],
    [{ time: 0.2, fingers: open }, { time: 1, fingers: closed }], [{ time: 0, fingers: open }, { time: NaN, fingers: closed }],
    Array.from({ length: 17 }, (_, i) => ({ time: i / 16, fingers: open }))]) {
    assert.equal(handPoseSchema.safeParse({ ...wave(), keyframes: keys }).success, false)
    assert.equal(handTimelineSchema.safeParse([
      { start: 0, end: 30, pose: { ...wave(), keyframes: keys } }, { start: 30, end: 60, pose: wave() }
    ]).success, false)
  }
  assert.equal(handTimelineSchema.safeParse([]).success, false)
})

test('branch timelines preserve parent spans exactly and append clips on the shared seam frame', () => {
  const original = handTimeline(wave(), 31), before = structuredClone(original)
  const next = handTimeline(wave(), 16, { frames: 31, pose: wave(), timeline: original })
  assert.deepEqual(next[0], original[0])
  assert.deepEqual(original, before)
  assert.equal(next[1].start, 30)
  assert.equal(next[1].end, 45)
  assert.deepEqual(handTimelineSchema.parse(next), next)
})

test('different finger endpoints require a transition; its interpolation joins both real poses', () => {
  const fist: HandPose = { version: 2, detail: 'basic', left: [0, 0, 0], right: [0, 0, 0], fingers: closed }
  assert.throws(() => handTimeline(fist, 31, { frames: 31, pose: defaultHandPose() }), /branch seam/)
  const timeline = handTimeline(fist, 31, { frames: 31, pose: defaultHandPose() }, 16)
  assert.deepEqual(timeline.map(s => [s.start, s.end]), [[0, 30], [30, 45], [45, 75]])
  const transition = timeline[1].pose
  assert.equal(transition.version, 2)
  if (transition.version === 2) assert.equal(fingerValuesAt(transition, 0.5).left.index, 0.5)
  assert.deepEqual(handTimelineSchema.parse(timeline), timeline)
  timeline[1].pose = fist
  assert.equal(handTimelineSchema.safeParse(timeline).success, false)
})
