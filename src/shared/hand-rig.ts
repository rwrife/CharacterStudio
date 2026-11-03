import { Quaternion, Vector3 } from 'three'
import { boneLinks, defaultLandmarks } from './rig'
import type { FingerPose, HandPose, HandSide, Landmarks, RigSetup, Vec3 } from './types'

export const handSides = ['left', 'right'] as const
export const fingerChains = [
  { name: 'Thumb', control: 'thumb', segments: 2, curl: [65, 65] },
  { name: 'Index', control: 'index', segments: 3, curl: [70, 90, 55] },
  { name: 'Fingers', control: 'fingers', segments: 3, curl: [70, 90, 55] }
] as const
export const handPrefix = (side: HandSide) => side === 'left' ? 'Left' : 'Right'
export const openFingers = (): FingerPose => ({ thumb: 0, index: 0, fingers: 0, opposition: 0 })

export function handPointNames(side: HandSide): string[] {
  const prefix = handPrefix(side)
  return [`${prefix}PalmNormal`, ...fingerChains.flatMap(chain =>
    Array.from({ length: chain.segments + 1 }, (_, i) => `${prefix}${chain.name}${i + 1}`))]
}

export function handLinks(setup: RigSetup): [string, string][] {
  return handSides.flatMap(side => setup.hands?.[side].detail !== 'basic' ? [] : [
    [`${handPrefix(side)}Hand`, `${handPrefix(side)}PalmNormal`] as [string, string],
    ...fingerChains.flatMap(chain => Array.from({ length: chain.segments }, (_, i): [string, string] =>
      [`${handPrefix(side)}${chain.name}${i + 1}`, `${handPrefix(side)}${chain.name}${i + 2}`]))
  ])
}

export function fittingPoints(setup: RigSetup): Landmarks {
  return Object.fromEntries([...Object.keys(defaultLandmarks()),
    ...handSides.flatMap(side => setup.hands?.[side].detail === 'basic' ? handPointNames(side) : [])
  ].filter(name => setup.landmarks[name]).map(name => [name, setup.landmarks[name]]))
}

export const fittingLinks = (setup: RigSetup): [string, string][] => [...boneLinks, ...handLinks(setup)]

export function handTemplate(setup: RigSetup, side: HandSide, detail: 'wrist' | 'basic'): RigSetup {
  const next = structuredClone(setup)
  next.hands ??= { left: { detail: 'wrist' }, right: { detail: 'wrist' } }
  for (const name of handPointNames(side)) delete next.landmarks[name]
  if (detail === 'wrist') {
    next.hands[side] = { detail }
    return next
  }
  const prefix = handPrefix(side)
  const wrist = new Vector3(...setup.landmarks[`${prefix}Hand`])
  const forward = new Vector3(...setup.landmarks[`${prefix}HandEnd`]).sub(wrist)
  const length = forward.length()
  forward.normalize()
  const normal = new Vector3(0, 1, 0)
  if (Math.abs(normal.dot(forward)) > 0.9) normal.set(0, 0, 1)
  normal.addScaledVector(forward, -normal.dot(forward)).normalize()
  const across = forward.clone().cross(normal).multiplyScalar(side === 'left' ? 1 : -1)
  const point = (along: number, lateral: number) => wrist.clone().addScaledVector(forward, along * length)
    .addScaledVector(across, lateral * length).toArray() as Vec3
  next.landmarks[`${prefix}PalmNormal`] = wrist.clone().addScaledVector(normal, length * 0.5).toArray()
  const positions = { Thumb: [[0.25, 0.18], [0.48, 0.38], [0.67, 0.48]],
    Index: [[0.5, 0.15], [0.72, 0.15], [0.88, 0.15], [1, 0.15]],
    Fingers: [[0.5, -0.15], [0.72, -0.15], [0.88, -0.15], [1, -0.15]] }
  for (const chain of fingerChains) positions[chain.name].forEach(([along, lateral], i) => {
    next.landmarks[`${prefix}${chain.name}${i + 1}`] = point(along, lateral)
  })
  next.hands[side] = { detail, thumbRadius: Math.max(0.003, Math.min(0.08, length * 0.12)),
    indexRadius: Math.max(0.003, Math.min(0.08, length * 0.1)), fingersRadius: Math.max(0.003, Math.min(0.08, length * 0.24)) }
  return next
}

export function fingerRotation(side: HandSide, chain: typeof fingerChains[number], segment: number, pose: FingerPose): Quaternion {
  const degrees = chain.curl[segment]
  if (degrees === undefined) throw new Error('Invalid finger segment.')
  const bend = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pose[chain.control] * degrees * Math.PI / 180)
  if (chain.control !== 'thumb' || segment !== 0) return bend
  return new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1),
    (side === 'left' ? 1 : -1) * pose.opposition * 60 * Math.PI / 180).multiply(bend)
}

export function assertHandPoseFits(pose: HandPose, setup: RigSetup) {
  if (pose.version === 1) return
  for (const side of handSides) if (setup.hands?.[side].detail !== 'basic' &&
    [pose.fingers, ...(pose.keyframes?.map(key => key.fingers) ?? [])].some(fingers => Object.values(fingers[side]).some(value => value !== 0)))
    throw new Error(`${handPrefix(side)} hand has no finger rig. Fit and build its Basic three-chain rig or reset its finger pose.`)
}

export function handRigConfiguration(setup: RigSetup) {
  return Object.fromEntries(handSides.map(side => [side, setup.hands?.[side].detail === 'basic'
    ? { ...setup.hands[side], rotation: setup.rotation, points: Object.fromEntries([`${handPrefix(side)}Hand`, ...handPointNames(side)].map(name => [name, setup.landmarks[name]])) }
    : { detail: 'wrist' }]))
}

export function handPoseConfiguration(pose: HandPose) {
  return { left: pose.left, right: pose.right,
    fingers: pose.version === 2 ? pose.fingers : { left: openFingers(), right: openFingers() } }
}
