import type { Landmarks } from './types'

// Normalized character height is 2m; Three.js coordinates are Y-up, facing +Z.
export function defaultLandmarks(): Landmarks {
  return {
    Hips: [0, 1.04, 0], Spine1: [0, 1.2, 0], Spine2: [0, 1.38, 0],
    Chest: [0, 1.52, 0], Neck1: [0, 1.68, 0], Head: [0, 1.79, 0], HeadEnd: [0, 1.98, 0],
    LeftShoulder: [0.1, 1.57, 0], LeftArm: [0.23, 1.58, 0],
    LeftForeArm: [0.53, 1.58, 0], LeftHand: [0.82, 1.58, 0], LeftHandEnd: [0.98, 1.58, 0],
    RightShoulder: [-0.1, 1.57, 0], RightArm: [-0.23, 1.58, 0],
    RightForeArm: [-0.53, 1.58, 0], RightHand: [-0.82, 1.58, 0], RightHandEnd: [-0.98, 1.58, 0],
    LeftLeg: [0.12, 1.01, 0], LeftShin: [0.12, 0.57, 0.035], LeftFoot: [0.12, 0.12, 0],
    LeftToeBase: [0.12, 0.055, 0.19], LeftToeEnd: [0.12, 0.055, 0.3],
    RightLeg: [-0.12, 1.01, 0], RightShin: [-0.12, 0.57, 0.035], RightFoot: [-0.12, 0.12, 0],
    RightToeBase: [-0.12, 0.055, 0.19], RightToeEnd: [-0.12, 0.055, 0.3]
  }
}

export const boneLinks: [string, string][] = [
  ['Hips', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Chest'], ['Chest', 'Neck1'], ['Neck1', 'Head'], ['Head', 'HeadEnd'],
  ...['Left', 'Right'].flatMap((s): [string, string][] => [
    ['Chest', `${s}Shoulder`], [`${s}Shoulder`, `${s}Arm`], [`${s}Arm`, `${s}ForeArm`],
    [`${s}ForeArm`, `${s}Hand`], [`${s}Hand`, `${s}HandEnd`],
    ['Hips', `${s}Leg`], [`${s}Leg`, `${s}Shin`], [`${s}Shin`, `${s}Foot`],
    [`${s}Foot`, `${s}ToeBase`], [`${s}ToeBase`, `${s}ToeEnd`]
  ])
]
