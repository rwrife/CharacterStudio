import { handPoseConfiguration, handSides, openFingers } from './hand-rig'
import type { FingerPose, FingerTrack, HandPose, HandPoseSpan } from './types'

export function fingerValuesAt(track: FingerTrack, time: number): FingerTrack['fingers'] {
  if (!Number.isFinite(time) || time < 0 || time > 1) throw new Error('Hand preview time must be between zero and one.')
  if (!track.keyframes) return structuredClone(track.fingers)
  const keys = track.keyframes
  const next = keys.findIndex(key => key.time >= time)
  if (next === 0) return structuredClone(keys[0].fingers)
  if (next < 0) throw new Error('Hand animation must end at time one.')
  const first = keys[next - 1], last = keys[next]
  const fraction = (time - first.time) / (last.time - first.time)
  const fingers = { left: openFingers(), right: openFingers() }
  for (const side of handSides) for (const key of Object.keys(fingers[side]) as (keyof FingerPose)[])
    fingers[side][key] = first.fingers[side][key] + (last.fingers[side][key] - first.fingers[side][key]) * fraction
  return fingers
}

export function poseAt(pose: HandPose, time: number): HandPose {
  return pose.version === 1 ? structuredClone(pose) : {
    version: 2, detail: 'basic', left: pose.left, right: pose.right, fingers: fingerValuesAt(pose, time)
  }
}

export function sameHandPose(first: HandPose, last: HandPose): boolean {
  const a = handPoseConfiguration(first), b = handPoseConfiguration(last)
  return handSides.every(side => a[side].every((v, i) => Math.abs(v - b[side][i]) < 1e-6) &&
    (Object.keys(a.fingers[side]) as (keyof FingerPose)[]).every(key => Math.abs(a.fingers[side][key] - b.fingers[side][key]) < 1e-6))
}

export function assertHandSeam(parent: HandPose, child: HandPose, transition: boolean) {
  if (!handSides.every(side => parent[side].every((v, i) => Math.abs(v - child[side][i]) < 1e-6)))
    throw new Error('Use the parent take\'s saved hand pose wrist offsets before branching, or start an independent motion.')
  if (!transition && !sameHandPose(poseAt(parent, 1), poseAt(child, 0)))
    throw new Error('Use the parent take\'s saved hand pose at the first key, or add a graph transition. Finger poses must meet at the branch seam.')
}

export function handTimeline(pose: HandPose, frames: number, parent?: { frames: number; pose: HandPose; timeline?: HandPoseSpan[] }, transitionFrames = 0): HandPoseSpan[] {
  if (!Number.isInteger(frames) || frames < 2 || !Number.isInteger(transitionFrames) || transitionFrames < 0 || transitionFrames === 1)
    throw new Error('Hand animation requires complete clip and transition frame counts.')
  if (!parent) return [{ start: 0, end: frames - 1, pose: structuredClone(pose) }]
  if (!Number.isInteger(parent.frames) || parent.frames < 2) throw new Error('Parent animation has an invalid frame count.')
  assertHandSeam(parent.pose, pose, transitionFrames > 0)
  const spans = structuredClone(parent.timeline ?? [{ start: 0, end: parent.frames - 1, pose: parent.pose }])
  if (!spans.length || spans[0].start !== 0 || spans.at(-1)!.end !== parent.frames - 1 ||
    spans.some((span, i) => span.end <= span.start || (i > 0 && span.start !== spans[i - 1].end)) || spans.length > 62)
    throw new Error('Parent take has an invalid or oversized saved hand timeline.')
  let start = parent.frames - 1
  if (transitionFrames) {
    const first = handPoseConfiguration(poseAt(parent.pose, 1)).fingers
    const last = handPoseConfiguration(poseAt(pose, 0)).fingers
    spans.push({ start, end: start + transitionFrames - 1, pose: { version: 2, detail: 'basic', left: pose.left, right: pose.right,
      fingers: first, keyframes: [{ time: 0, fingers: first }, { time: 1, fingers: last }] } })
    start += transitionFrames - 1
  }
  spans.push({ start, end: start + frames - 1, pose: structuredClone(pose) })
  return spans
}
