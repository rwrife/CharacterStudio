import type { AiProvenance } from './ai'
import type { Landmarks, Vec3 } from './types'

// MediaPipe Pose Landmarker (33 points). World landmarks are metres, hip-centred,
// x toward image right (the subject's left when facing the camera), y down, z away from the camera.
export const POSE = {
  nose: 0, leftEye: 2, rightEye: 5, leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18, leftIndex: 19, rightIndex: 20,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30, leftFootIndex: 31, rightFootIndex: 32
} as const
export const POSE_POINTS = 33
export const POSE_LINKS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [15, 17], [16, 20], [16, 18],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [27, 31], [29, 31], [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
  [7, 2], [2, 0], [0, 5], [5, 8]
]

export const MOCAP_FPS = 30
export const MOCAP_MAX_SECONDS = 180
export const MOCAP_MAX_FRAMES = MOCAP_FPS * MOCAP_MAX_SECONDS + 1
export const MOCAP_RECORD_SECONDS = 90
export const MOCAP_MIN_DETECTION = 0.5
export const HEAD_PITCH = (15 * Math.PI) / 180
export const MOCAP_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v'] as const
export const MOCAP_MAX_VIDEO_BYTES = 1024 ** 3
export const MOCAP_MAX_RECORDING_BYTES = 256 * 1024 ** 2

export type MocapPoseModel = 'lite' | 'full'
export const MOCAP_MODELS: Record<MocapPoseModel, { label: string; detail: string; url: string; sha256: string; bytes: number }> = {
  lite: {
    label: 'Pose Lite', detail: 'Fastest; best for low-power CPUs and webcam takes.',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a', bytes: 5777746
  },
  full: {
    label: 'Pose Full', detail: 'Steadier limbs; roughly 2x slower than Lite on the CPU.',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1', bytes: 9398198
  }
}

export type MocapSubject = 'primary' | 'left' | 'right'
export const MOCAP_SUBJECTS: Record<MocapSubject, string> = {
  primary: 'Primary performer',
  left: 'Leftmost person',
  right: 'Rightmost person'
}
/** Up to this many people are tracked when the subject is chosen by position. */
export const MOCAP_MAX_PEOPLE = 3

/** One detected pose: 33 world landmarks as [x, y, z, visibility]; null when no person was found. */
export type PoseFrame = [number, number, number, number][] | null
export interface MocapCapture {
  version: 1
  /** Built-in MediaPipe model, or 'provider' for a capture returned by a routed ComfyUI/API provider. */
  model: MocapPoseModel | 'provider'
  fps: number
  width: number
  height: number
  frames: PoseFrame[]
  /** Clip start within the source video, in seconds. Frames cover start to start + (frames - 1) / fps. */
  start?: number
  subject?: MocapSubject
}
export interface MocapCaptureRequest {
  takeId: string
  start: number
  end: number
  subject: MocapSubject
}
export interface MocapOptions {
  /** 0 keeps fast detail, 1 removes the most jitter. */
  smoothing: number
  legs: 'auto' | 'track' | 'lock'
  mirror: boolean
  hipHeight: boolean
}
export const defaultMocapOptions = (): MocapOptions => ({ smoothing: 0.5, legs: 'auto', mirror: false, hipHeight: true })

export interface MocapCaptureSummary {
  model: MocapPoseModel | 'provider'
  start: number
  subject: MocapSubject
  /** Non-sensitive provider route and workflow provenance for routed captures. */
  provenance?: AiProvenance
  fps: number
  frames: number
  detected: number
  width: number
  height: number
  capturedAt: string
}
export interface MocapTake {
  id: string
  name: string
  createdAt: string
  source: 'file' | 'webcam'
  videoUrl: string
  videoFile: string
  bytes: number
  capture?: MocapCaptureSummary
}
export interface MocapModelState {
  status: 'missing' | 'downloading' | 'ready' | 'failed'
  progress?: number
  message?: string
}
export interface MocapSnapshot {
  takes: MocapTake[]
  models: Record<MocapPoseModel, MocapModelState>
}
export interface MocapExportRequest {
  takeId: string
  characterId: string
  options: MocapOptions
}

/** Validate an untrusted capture payload (renderer or disk) without copying it through a schema library. */
export function parseCapture(value: unknown): MocapCapture {
  const fail = (message: string): never => { throw new Error(`Invalid pose capture: ${message}`) }
  if (!value || typeof value !== 'object') fail('expected an object')
  const v = value as Record<string, unknown>
  const keys = Object.keys(v).filter(key => key !== 'start' && key !== 'subject').sort().join(',')
  if (keys !== 'fps,frames,height,model,version,width') fail('unexpected fields')
  if (v.version !== 1) fail('unsupported version')
  if (v.model !== 'lite' && v.model !== 'full' && v.model !== 'provider') fail('unknown pose model')
  if (v.start !== undefined && (typeof v.start !== 'number' || !(v.start >= 0 && v.start <= MOCAP_MAX_SECONDS * 10))) fail('invalid clip start')
  if (v.subject !== undefined && !Object.hasOwn(MOCAP_SUBJECTS, v.subject as string)) fail('unknown subject')
  if (typeof v.fps !== 'number' || !Number.isFinite(v.fps) || v.fps < 5 || v.fps > 60) fail('frame rate must be 5-60 fps')
  for (const key of ['width', 'height'] as const) {
    const size = v[key]
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 16 || size > 8192) fail(`${key} must be 16-8192 pixels`)
  }
  if (!Array.isArray(v.frames) || v.frames.length < 2 || v.frames.length > MOCAP_MAX_FRAMES) fail(`expected 2-${MOCAP_MAX_FRAMES} frames`)
  const frames = v.frames as unknown[]
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f]
    if (frame === null) continue
    if (!Array.isArray(frame) || frame.length !== POSE_POINTS) fail(`frame ${f + 1} must have ${POSE_POINTS} landmarks`)
    for (const point of frame as unknown[]) {
      if (!Array.isArray(point) || point.length !== 4) fail(`frame ${f + 1} has a malformed landmark`)
      const [x, y, z, visibility] = point as unknown[]
      for (const n of [x, y, z]) if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10) fail(`frame ${f + 1} has an out-of-range coordinate`)
      if (typeof visibility !== 'number' || !(visibility >= 0 && visibility <= 1)) fail(`frame ${f + 1} has an invalid visibility`)
    }
  }
  return value as MocapCapture
}

/** Validate a clip-range capture request from the renderer. The end is checked against the video length during capture. */
export function parseCaptureRequest(value: unknown): MocapCaptureRequest {
  const v = (value ?? {}) as Record<string, unknown>
  if (typeof v !== 'object' || Object.keys(v).some(key => !['takeId', 'start', 'end', 'subject'].includes(key))) throw new Error('Invalid capture request.')
  if (typeof v.takeId !== 'string' || !/^[0-9a-f-]{36}$/.test(v.takeId)) throw new Error('Choose a take to capture.')
  if (typeof v.start !== 'number' || typeof v.end !== 'number' || !Number.isFinite(v.start) || !Number.isFinite(v.end) || v.start < 0)
    throw new Error('The clip range must be a start and end time in seconds.')
  if (v.end - v.start < 2 / MOCAP_FPS) throw new Error('The clip end must be after its start.')
  if (v.end - v.start > MOCAP_MAX_SECONDS + 0.05) throw new Error(`Capture at most ${MOCAP_MAX_SECONDS / 60} minutes at a time. Shorten the clip range.`)
  if (typeof v.subject !== 'string' || !Object.hasOwn(MOCAP_SUBJECTS, v.subject)) throw new Error('Choose a subject to capture.')
  return { takeId: v.takeId, start: v.start, end: v.end, subject: v.subject as MocapSubject }
}

/** Expected frame count for a clip sampled at `fps`, including both endpoints. */
export const clipFrames = (start: number, end: number, fps = MOCAP_FPS) => Math.max(2, Math.floor((end - start) * fps + 1e-6) + 1)

/**
 * Validate a routed provider's capture output: MediaPipe-compatible 33-point world landmarks for the requested clip.
 * Providers return { version, fps, width, height, frames }; the clip and subject come from the request, not the provider.
 */
export function parseProviderCapture(value: unknown, request: MocapCaptureRequest): MocapCapture {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid pose capture: expected an object')
  const capture = parseCapture({ ...parsed as Record<string, unknown>, model: 'provider' })
  const expected = clipFrames(request.start, request.end, capture.fps)
  if (Math.abs(capture.frames.length - expected) > Math.max(2, Math.ceil(capture.fps * 0.1)))
    throw new Error(`The capture provider returned ${capture.frames.length} frames; expected about ${expected} for this clip at ${capture.fps} fps. No capture was saved.`)
  return { ...capture, start: request.start, subject: request.subject }
}

export function parseMocapOptions(value: unknown): MocapOptions {
  const v = (value ?? {}) as Record<string, unknown>
  if (typeof v !== 'object' || Object.keys(v).some(key => !['smoothing', 'legs', 'mirror', 'hipHeight'].includes(key))) throw new Error('Invalid mocap options.')
  if (typeof v.smoothing !== 'number' || !(v.smoothing >= 0 && v.smoothing <= 1)) throw new Error('Smoothing must be between 0 and 1.')
  if (v.legs !== 'auto' && v.legs !== 'track' && v.legs !== 'lock') throw new Error('Legs must be auto, track or lock.')
  if (typeof v.mirror !== 'boolean' || typeof v.hipHeight !== 'boolean') throw new Error('Mirror and hip height must be on or off.')
  return { smoothing: v.smoothing, legs: v.legs, mirror: v.mirror, hipHeight: v.hipHeight }
}

export const MOCAP_BONES = [
  'Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Head',
  ...['Left', 'Right'].flatMap(s => [`${s}Shoulder`, `${s}Arm`, `${s}ForeArm`, `${s}Hand`, `${s}Leg`, `${s}Shin`, `${s}Foot`, `${s}ToeBase`])
]
export interface MocapMotion {
  version: 1
  fps: number
  frames: number
  bones: string[]
  /** World-space rotation from the rest pose, per frame and bone, as [w, x, y, z] in character space (Y-up, facing +Z). */
  rotations: [number, number, number, number][][]
  /** Hips offset from rest in character space metres (2m character height). */
  hips: Vec3[]
  legs: 'tracked' | 'locked'
  detected: number
  warnings: string[]
}

type V = [number, number, number]
type Q = [number, number, number, number]
type M = [V, V, V] // columns
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const length = (a: V) => Math.hypot(a[0], a[1], a[2])
const mid = (a: V, b: V): V => scale(add(a, b), 0.5)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
function normalize(a: V, fallback: V = [0, 1, 0]): V {
  const l = length(a)
  return l > 1e-9 ? scale(a, 1 / l) : fallback
}
function perpendicular(a: V): V {
  return normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]))
}

/** Right-handed orthonormal basis: primary as x, secondary orthogonalised as z. */
function basis(primary: V, secondary: V): M {
  const x = normalize(primary)
  let z = sub(secondary, scale(x, dot(secondary, x)))
  z = length(z) > 1e-6 ? normalize(z) : perpendicular(x)
  return [x, cross(z, x), z]
}
const apply = (m: M, v: V): V => add(add(scale(m[0], v[0]), scale(m[1], v[1])), scale(m[2], v[2]))
/** Rotation mapping rest basis onto observed basis: obs · restᵀ. */
function delta(obs: M, rest: M): M {
  const t: M = [[rest[0][0], rest[1][0], rest[2][0]], [rest[0][1], rest[1][1], rest[2][1]], [rest[0][2], rest[1][2], rest[2][2]]]
  return [apply(obs, t[0]), apply(obs, t[1]), apply(obs, t[2])]
}
function quatFromMatrix(m: M): Q {
  const [m00, m10, m20] = m[0], [m01, m11, m21] = m[1], [m02, m12, m22] = m[2]
  const trace = m00 + m11 + m22
  let q: Q
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    q = [0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s]
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s]
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s]
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s]
  }
  return qnormalize(q)
}
function qnormalize(q: Q): Q {
  const l = Math.hypot(...q)
  return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [1, 0, 0, 0]
}
export function qmul(a: Q, b: Q): Q {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
  ]
}
const qconj = (q: Q): Q => [q[0], -q[1], -q[2], -q[3]]
export function qrotate(q: Q, v: V): V {
  const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q))
  return [r[1], r[2], r[3]]
}
function slerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const c: Q = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b
  d = Math.abs(d)
  if (d > 0.9995) return qnormalize([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t, a[3] + (c[3] - a[3]) * t])
  const theta = Math.acos(d), s = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / s, wb = Math.sin(t * theta) / s
  return [a[0] * wa + c[0] * wb, a[1] * wa + c[1] * wb, a[2] * wa + c[2] * wb, a[3] * wa + c[3] * wb]
}
/** Shortest rotation taking direction a onto direction b, limited to maxAngle radians. */
function between(a: V, b: V, maxAngle = Math.PI): Q {
  const u = normalize(a), v = normalize(b)
  const d = clamp(dot(u, v), -1, 1)
  let axis = cross(u, v)
  if (length(axis) < 1e-8) {
    if (d > 0) return [1, 0, 0, 0]
    axis = perpendicular(u)
  }
  const angle = Math.min(Math.acos(d), maxAngle)
  const n = normalize(axis)
  const s = Math.sin(angle / 2)
  return [Math.cos(angle / 2), n[0] * s, n[1] * s, n[2] * s]
}
function limit(q: Q, maxAngle: number): Q {
  const w = clamp(Math.abs(q[0]), -1, 1)
  const angle = 2 * Math.acos(w)
  if (angle <= maxAngle) return q
  const sign = q[0] < 0 ? -1 : 1
  const axis = normalize([q[1] * sign, q[2] * sign, q[3] * sign])
  const s = Math.sin(maxAngle / 2)
  return [Math.cos(maxAngle / 2), axis[0] * s, axis[1] * s, axis[2] * s]
}

/** Convert a MediaPipe world landmark into character space (Y-up, facing +Z, subject's left at +X). */
export function toCharacterSpace(point: readonly number[], mirror = false): V {
  return [mirror ? -point[0] : point[0], -point[1], -point[2]]
}
const MIRROR_INDEX = (() => {
  const map = Array.from({ length: POSE_POINTS }, (_, i) => i)
  const pairs: [number, number][] = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]]
  for (const [a, b] of pairs) { map[a] = b; map[b] = a }
  return map
})()

class LowPass {
  value?: number
  filter(x: number, alpha: number) { this.value = this.value === undefined ? x : alpha * x + (1 - alpha) * this.value; return this.value }
}
/** One Euro filter (Casiez et al. 2012): adaptive low-pass that keeps fast motion responsive. */
class OneEuro {
  private x = new LowPass()
  private dx = new LowPass()
  private last?: number
  constructor(private rate: number, private minCutoff: number, private beta: number, private dCutoff = 1) {}
  private alpha(cutoff: number) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau * this.rate) }
  filter(value: number) {
    const derivative = this.last === undefined ? 0 : (value - this.last) * this.rate
    this.last = value
    const edx = this.dx.filter(derivative, this.alpha(this.dCutoff))
    return this.x.filter(value, this.alpha(this.minCutoff + this.beta * Math.abs(edx)))
  }
}

/** Fill undetected frames by interpolating neighbouring detections; hold at the ends. */
export function fillGaps(frames: PoseFrame[]): { points: V[][]; visibility: number[][]; detected: number } {
  const known = frames.flatMap((f, i) => f ? [i] : [])
  if (!known.length) throw new Error('No person was detected in this take.')
  const points: V[][] = [], visibility: number[][] = []
  let k = 0
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    if (frame) {
      points.push(frame.map(p => [p[0], p[1], p[2]] as V)); visibility.push(frame.map(p => p[3]))
      continue
    }
    while (k < known.length - 1 && known[k + 1] < i) k++
    const before = known[k] < i ? known[k] : undefined
    const after = known.find(j => j > i)
    const a = frames[before ?? after!]!, b = frames[after ?? before!]!
    const t = before === undefined || after === undefined ? 0 : (i - before) / (after - before)
    points.push(a.map((p, j) => [p[0] + (b[j][0] - p[0]) * t, p[1] + (b[j][1] - p[1]) * t, p[2] + (b[j][2] - p[2]) * t] as V))
    visibility.push(a.map(() => 0))
  }
  return { points, visibility, detected: known.length }
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
}

function finiteLandmark(landmarks: Landmarks, name: string): V {
  const point = landmarks[name]
  if (!point || point.length !== 3 || !point.every(Number.isFinite)) throw new Error(`Rig landmark ${name} is missing.`)
  return [point[0], point[1], point[2]]
}

/**
 * Solve per-bone rotations for the Studio humanoid from captured pose landmarks.
 * Rotations are world-space deltas from the fitted rest pose, so any T- or A-pose rest works.
 */
export function solveMocap(capture: MocapCapture, landmarks: Landmarks, options: MocapOptions): MocapMotion {
  if (capture.frames.length < 2) throw new Error('The capture needs at least two frames.')
  if (capture.frames.length > MOCAP_MAX_FRAMES) throw new Error(`Captures are limited to ${MOCAP_MAX_SECONDS} seconds.`)
  const filled = fillGaps(capture.frames)
  if (filled.detected < 2 || filled.detected / capture.frames.length < MOCAP_MIN_DETECTION)
    throw new Error(`A person was detected in only ${filled.detected} of ${capture.frames.length} frames. Use a take with the full body visible in at least ${MOCAP_MIN_DETECTION * 100}% of frames.`)
  const warnings: string[] = []
  const smoothing = clamp(options.smoothing, 0, 1)
  const filters = Array.from({ length: POSE_POINTS * 3 }, () => new OneEuro(capture.fps, 4 + (0.5 - 4) * smoothing, 0.3))
  const frames = filled.points.map(frame => {
    const source = options.mirror ? MIRROR_INDEX.map(i => frame[i]) : frame
    return source.map((p, i) => {
      const v = toCharacterSpace(p, options.mirror)
      return [filters[i * 3].filter(v[0]), filters[i * 3 + 1].filter(v[1]), filters[i * 3 + 2].filter(v[2])] as V
    })
  })
  const legIndices = [POSE.leftKnee, POSE.rightKnee, POSE.leftAnkle, POSE.rightAnkle]
  const legVisibility = median(capture.frames.flatMap(f => f ? legIndices.map(i => f[i][3]) : []))
  const lockLegs = options.legs === 'lock' || (options.legs === 'auto' && legVisibility < 0.5)
  if (lockLegs) warnings.push(options.legs === 'lock' ? 'Legs locked to the rest pose; upper body only.' : 'Knees and ankles were rarely visible, so legs were locked to the rest pose. Choose Legs: Always track legs to override.')
  if (filled.detected < capture.frames.length) warnings.push(`${capture.frames.length - filled.detected} undetected frames were interpolated.`)
  if (options.mirror) warnings.push('Performance mirrored left/right.')

  const L = (name: string) => finiteLandmark(landmarks, name)
  const restHipLat = sub(L('LeftLeg'), L('RightLeg'))
  const restTorsoUp = sub(mid(L('LeftArm'), L('RightArm')), mid(L('LeftLeg'), L('RightLeg')))
  const restHips = basis(restHipLat, restTorsoUp)
  const restChest = basis(sub(L('LeftArm'), L('RightArm')), restTorsoUp)
  // With a level gaze, MediaPipe's eye landmarks sit slightly above the ears.
  const restHead = basis([1, 0, 0], [0, Math.sin(HEAD_PITCH), Math.cos(HEAD_PITCH)])
  type Limb = { upper: string; lower: string; end: string; tip: string; a: number; b: number; c: number; bend: V; parent: 'chest' | 'hips' }
  const limbs: Limb[] = (['Left', 'Right'] as const).flatMap(side => {
    const l = side === 'Left'
    return [
      { upper: `${side}Arm`, lower: `${side}ForeArm`, end: `${side}Hand`, tip: `${side}HandEnd`, a: l ? POSE.leftShoulder : POSE.rightShoulder, b: l ? POSE.leftElbow : POSE.rightElbow, c: l ? POSE.leftWrist : POSE.rightWrist, bend: [0, 0, 1] as V, parent: 'chest' as const },
      { upper: `${side}Leg`, lower: `${side}Shin`, end: `${side}Foot`, tip: `${side}ToeBase`, a: l ? POSE.leftHip : POSE.rightHip, b: l ? POSE.leftKnee : POSE.rightKnee, c: l ? POSE.leftAnkle : POSE.rightAnkle, bend: [0, 0, -1] as V, parent: 'hips' as const }
    ]
  })
  const restLimb = limbs.map(limb => {
    const u = sub(L(limb.lower), L(limb.upper)), l = sub(L(limb.end), L(limb.lower))
    const n = normalize(cross(u, limb.bend), perpendicular(u))
    return { u, l, n, upper: basis(u, n), lower: basis(l, n), endDir: sub(L(limb.tip), L(limb.end)) }
  })

  const restHipY = L('Hips')[1]
  const floor = frames.map(f => -Math.min(...[27, 28, 29, 30, 31, 32].map(i => f[i][1])))
  const reference = percentile(floor, 0.9)
  const trackHeight = options.hipHeight && !lockLegs && reference > 0.2
  if (options.hipHeight && !trackHeight && !lockLegs) warnings.push('Hip height could not be estimated; root height kept at rest.')

  const identity: Q = [1, 0, 0, 0]
  const previous = new Map<string, Q>()
  const rotations: Q[][] = [], hips: Vec3[] = []
  for (const p of frames) {
    const out = new Map<string, Q>()
    const torsoUp = sub(mid(p[POSE.leftShoulder], p[POSE.rightShoulder]), mid(p[POSE.leftHip], p[POSE.rightHip]))
    const chest = quatFromMatrix(delta(basis(sub(p[POSE.leftShoulder], p[POSE.rightShoulder]), torsoUp), restChest))
    const hipsQ = lockLegs ? identity : quatFromMatrix(delta(basis(sub(p[POSE.leftHip], p[POSE.rightHip]), torsoUp), restHips))
    const earMid = mid(p[POSE.leftEar], p[POSE.rightEar])
    const forward = sub(mid(p[POSE.leftEye], p[POSE.rightEye]), earMid)
    const headWorld = quatFromMatrix(delta(basis(sub(p[POSE.leftEar], p[POSE.rightEar]), forward), restHead))
    const head = qmul(chest, limit(qmul(qconj(chest), headWorld), (70 * Math.PI) / 180))
    out.set('Hips', hipsQ)
    out.set('Spine1', slerp(hipsQ, chest, 1 / 3))
    out.set('Spine2', slerp(hipsQ, chest, 2 / 3))
    out.set('Chest', chest)
    out.set('Neck1', slerp(chest, head, 0.5))
    out.set('Head', head)
    out.set('LeftShoulder', chest)
    out.set('RightShoulder', chest)
    limbs.forEach((limb, index) => {
      const rest = restLimb[index]
      const parent = limb.parent === 'chest' ? chest : hipsQ
      if (limb.parent === 'hips' && lockLegs) {
        for (const name of [limb.upper, limb.lower, limb.end, limb.tip]) out.set(name, identity)
        return
      }
      const u = sub(p[limb.b], p[limb.a]), l = sub(p[limb.c], p[limb.b])
      const measured = cross(normalize(u), normalize(l))
      const bent = clamp((length(measured) - 0.1) / 0.25, 0, 1)
      const carried = qrotate(parent, rest.n)
      const fallback = sub(carried, scale(normalize(u), dot(carried, normalize(u))))
      const n = normalize(add(scale(normalize(measured, fallback), bent), scale(normalize(fallback, perpendicular(u)), 1 - bent)), perpendicular(u))
      const upper = quatFromMatrix(delta(basis(u, n), rest.upper))
      const lower = quatFromMatrix(delta(basis(l, n), rest.lower))
      out.set(limb.upper, upper)
      out.set(limb.lower, lower)
      let target: V
      if (limb.parent === 'chest') {
        const side = limb.upper.startsWith('Left')
        target = sub(mid(p[side ? POSE.leftIndex : POSE.rightIndex], p[side ? POSE.leftPinky : POSE.rightPinky]), p[limb.c])
      } else {
        target = sub(p[limb.upper.startsWith('Left') ? POSE.leftFootIndex : POSE.rightFootIndex], p[limb.c])
      }
      const end = qmul(between(qrotate(lower, rest.endDir), target, (65 * Math.PI) / 180), lower)
      out.set(limb.end, end)
      if (limb.parent === 'hips') out.set(limb.tip, end)
    })
    const row = MOCAP_BONES.map(name => {
      let q = qnormalize(out.get(name)!)
      const last = previous.get(name)
      if (last && q[0] * last[0] + q[1] * last[1] + q[2] * last[2] + q[3] * last[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]]
      if (!q.every(Number.isFinite)) throw new Error(`Pose solve produced an invalid ${name} rotation.`)
      previous.set(name, q)
      return q
    })
    rotations.push(row)
    const height = trackHeight ? clamp((Math.max(0, -Math.min(...[27, 28, 29, 30, 31, 32].map(i => p[i][1]))) - reference) * restHipY / reference, -restHipY * 0.75, restHipY * 0.25) : 0
    hips.push([0, Number.isFinite(height) ? height : 0, 0])
  }
  warnings.push('Body only: fingers, face and wrist twist are not captured. Motion is in place; check feet for sliding.')
  return { version: 1, fps: capture.fps, frames: frames.length, bones: [...MOCAP_BONES], rotations, hips, legs: lockLegs ? 'locked' : 'tracked', detected: filled.detected, warnings }
}
