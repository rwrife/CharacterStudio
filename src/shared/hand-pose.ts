import { Euler, MathUtils, Quaternion } from 'three'
import type { HandPose, Vec3 } from './types'

export function defaultHandPose(): Extract<HandPose, { version: 1 }> {
  return { version: 1, detail: 'wrist', left: [0, 0, 0], right: [0, 0, 0] }
}

// XYZ degrees in the normalized character's rest-frame axes (+Y up, +Z forward).
// Transport the correction with the animated wrist, rather than a fixed world axis.
export function wristCorrection(rotation: Vec3, restWorld: Quaternion): Quaternion {
  const offset = new Quaternion().setFromEuler(new Euler(...rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'))
  return restWorld.clone().invert().multiply(offset).multiply(restWorld)
}
