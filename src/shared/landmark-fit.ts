import type { Landmarks, Vec3 } from './types'
import { boneLinks } from './rig'

/** Triangle geometry in the import-normalized Three.js frame (Y-up, facing +Z). */
export interface MeshGeometry { positions: Float32Array; indices: Uint32Array }
export interface LandmarkFit {
  landmarks: Landmarks
  warnings: string[]
  /** Landmarks that remain outside the mesh after fitting. */
  outside: string[]
  measurements: Record<string, number>
}

export class LandmarkFitError extends Error {}

const CELL = 0.01
const HEIGHT = 2
const SIDES = [['Left', 1], ['Right', -1]] as const

const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return Number.NaN
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))
const round = (value: number) => Math.round(value * 1000) / 1000

/** Applies the setup rotation (Three.js Euler XYZ, degrees) and the rig-stage height-2 normalization. */
export function orientGeometry(geometry: MeshGeometry, rotation: Vec3): Float32Array {
  const [x, y, z] = rotation.map(value => value * Math.PI / 180)
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z)
  const m = [c * e, -c * f, d, a * f + b * e * d, a * e - b * f * d, -b * c, b * f - a * e * d, b * e + a * f * d, a * c]
  const source = geometry.positions, out = new Float32Array(source.length)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < source.length; i += 3) {
    const px = source[i], py = source[i + 1], pz = source[i + 2]
    for (let axis = 0; axis < 3; axis++) {
      const value = m[axis * 3] * px + m[axis * 3 + 1] * py + m[axis * 3 + 2] * pz
      out[i + axis] = value
      if (value < lo[axis]) lo[axis] = value
      if (value > hi[axis]) hi[axis] = value
    }
  }
  const height = hi[1] - lo[1]
  if (!Number.isFinite(height) || height < 1e-6) throw new LandmarkFitError('Mesh has zero height or non-finite coordinates.')
  const scale = HEIGHT / height, cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2
  for (let i = 0; i < out.length; i += 3) {
    out[i] = (out[i] - cx) * scale
    out[i + 1] = (out[i + 1] - lo[1]) * scale
    out[i + 2] = (out[i + 2] - cz) * scale
  }
  return out
}

/** Vertices plus deterministic area-weighted surface samples, so large triangles still cover the silhouette. */
function samplePoints(positions: Float32Array, indices: Uint32Array) {
  const triangles = indices.length / 3, areas = new Float64Array(triangles)
  let total = 0
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    areas[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    total += areas[t]
  }
  const target = total > 0 ? Math.round(clamp(total / 1.6e-5, 150_000, 900_000)) : 0
  const points = new Float32Array(positions.length + (target + 2) * 3)
  points.set(positions)
  let count = positions.length / 3, carry = 0, seed = 0x9e3779b9
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  for (let t = 0; t < triangles && target; t++) {
    carry += areas[t] / total * target
    const samples = Math.floor(carry)
    carry -= samples
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
    for (let k = 0; k < samples && count < points.length / 3; k++) {
      let u = random(), v = random()
      if (u + v > 1) { u = 1 - u; v = 1 - v }
      for (let axis = 0; axis < 3; axis++)
        points[count * 3 + axis] = positions[a + axis] + u * (positions[b + axis] - positions[a + axis]) + v * (positions[c + axis] - positions[a + axis])
      count++
    }
  }
  return points.subarray(0, count * 3)
}

interface Box { n: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
const emptyBox = (): Box => ({ n: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity })
const center = (box: Box): Vec3 => [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2]

/** Surface points bucketed by height rows for fast slice queries. */
class PointIndex {
  readonly rows = Math.ceil(HEIGHT / CELL) + 1
  private readonly start: Uint32Array
  private readonly order: Uint32Array

  constructor(readonly points: Float32Array) {
    const count = points.length / 3, rowOf = new Uint16Array(count)
    this.start = new Uint32Array(this.rows + 1)
    for (let i = 0; i < count; i++) {
      rowOf[i] = clamp(Math.floor(points[i * 3 + 1] / CELL), 0, this.rows - 1)
      this.start[rowOf[i] + 1]++
    }
    for (let r = 0; r < this.rows; r++) this.start[r + 1] += this.start[r]
    const cursor = this.start.slice(0, this.rows)
    this.order = new Uint32Array(count)
    for (let i = 0; i < count; i++) this.order[cursor[rowOf[i]]++] = i
  }

  box(y0: number, y1: number, keep: (x: number, y: number, z: number) => boolean): Box {
    const box = emptyBox(), points = this.points
    const r0 = clamp(Math.floor(y0 / CELL), 0, this.rows - 1), r1 = clamp(Math.floor(y1 / CELL), 0, this.rows - 1)
    for (let k = this.start[r0]; k < this.start[r1 + 1]; k++) {
      const i = this.order[k] * 3, x = points[i], y = points[i + 1], z = points[i + 2]
      if (y < y0 || y > y1 || !keep(x, y, z)) continue
      box.n++
      if (x < box.minX) box.minX = x
      if (x > box.maxX) box.maxX = x
      if (y < box.minY) box.minY = y
      if (y > box.maxY) box.maxY = y
      if (z < box.minZ) box.minZ = z
      if (z > box.maxZ) box.maxZ = z
    }
    return box
  }
}

type Run = [number, number]

/** Front (X/Y) silhouette rasterized from surface samples and closed to remove pinholes. */
class Silhouette {
  readonly minX: number
  readonly cols: number
  readonly rows = Math.ceil(HEIGHT / CELL) + 2
  private readonly data: Uint8Array

  constructor(points: Float32Array) {
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < points.length; i += 3) { lo = Math.min(lo, points[i]); hi = Math.max(hi, points[i]) }
    this.minX = lo - 2 * CELL
    this.cols = Math.ceil((hi - this.minX) / CELL) + 3
    const raw = new Uint8Array(this.cols * this.rows)
    for (let i = 0; i < points.length; i += 3) raw[this.row(points[i + 1]) * this.cols + this.col(points[i])] = 1
    const dilated = new Uint8Array(raw.length)
    for (let r = 1; r < this.rows - 1; r++)
      for (let c = 1; c < this.cols - 1; c++)
        dilated[r * this.cols + c] = raw[r * this.cols + c] | raw[r * this.cols + c - 1] | raw[r * this.cols + c + 1] |
          raw[(r - 1) * this.cols + c] | raw[(r + 1) * this.cols + c]
    this.data = new Uint8Array(raw.length)
    for (let r = 1; r < this.rows - 1; r++)
      for (let c = 1; c < this.cols - 1; c++)
        this.data[r * this.cols + c] = raw[r * this.cols + c] | (dilated[r * this.cols + c] & dilated[r * this.cols + c - 1] &
          dilated[r * this.cols + c + 1] & dilated[(r - 1) * this.cols + c] & dilated[(r + 1) * this.cols + c])
  }

  col(x: number) { return clamp(Math.floor((x - this.minX) / CELL), 0, this.cols - 1) }
  row(y: number) { return clamp(Math.floor(y / CELL), 0, this.rows - 1) }
  x(col: number) { return this.minX + (col + 0.5) * CELL }
  filled(col: number, row: number) { return col >= 0 && col < this.cols && row >= 0 && row < this.rows && this.data[row * this.cols + col] === 1 }

  rowRuns(row: number): Run[] {
    const runs: Run[] = []
    for (let c = 0; c < this.cols; c++) {
      if (!this.filled(c, row)) continue
      const start = c
      while (this.filled(c + 1, row)) c++
      runs.push([start, c])
    }
    return runs
  }

  columnRuns(col: number): Run[] {
    const runs: Run[] = []
    for (let r = 0; r < this.rows; r++) {
      if (!this.filled(col, r)) continue
      const start = r
      while (this.filled(col, r + 1)) r++
      runs.push([start, r])
    }
    return runs
  }
}

const nearestRun = (runs: Run[], target: number) => {
  let best: Run | undefined, distance = Infinity
  for (const run of runs) {
    const d = target < run[0] ? run[0] - target : target > run[1] ? target - run[1] : 0
    if (d < distance) { distance = d; best = run }
  }
  return best && { run: best, distance }
}

/** Marks landmarks enclosed by the surface: each of the six axis rays must hit a triangle. */
export function enclosedPoints(positions: Float32Array, indices: Uint32Array, points: Vec3[]) {
  const hits = points.map(() => new Uint8Array(6))
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const v = [[positions[a], positions[a + 1], positions[a + 2]], [positions[b], positions[b + 1], positions[b + 2]], [positions[c], positions[c + 1], positions[c + 2]]]
    const lo = [0, 1, 2].map(axis => Math.min(v[0][axis], v[1][axis], v[2][axis]))
    const hi = [0, 1, 2].map(axis => Math.max(v[0][axis], v[1][axis], v[2][axis]))
    const e1 = [0, 1, 2].map(axis => v[1][axis] - v[0][axis]), e2 = [0, 1, 2].map(axis => v[2][axis] - v[0][axis])
    const normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    points.forEach((point, p) => {
      for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3, w = (axis + 2) % 3
        if (!normal[axis] || point[u] < lo[u] || point[u] > hi[u] || point[w] < lo[w] || point[w] > hi[w]) continue
        let inside = true, sign = 0
        for (let k = 0; k < 3 && inside; k++) {
          const p0 = v[k], p1 = v[(k + 1) % 3]
          const cross = (p1[u] - p0[u]) * (point[w] - p0[w]) - (p1[w] - p0[w]) * (point[u] - p0[u])
          if (cross === 0) continue
          if (!sign) sign = Math.sign(cross)
          else if (Math.sign(cross) !== sign) inside = false
        }
        if (!inside) continue
        const along = v[0][axis] - (normal[u] * (point[u] - v[0][u]) + normal[w] * (point[w] - v[0][w])) / normal[axis]
        hits[p][axis * 2 + (along >= point[axis] ? 0 : 1)] = 1
      }
    })
  }
  return hits.map(hit => hit.every(Boolean))
}

interface ArmColumn { col: number; x: number; bottom: number; top: number }

function lineFit(items: ArmColumn[], value: (item: ArmColumn) => number) {
  const mx = items.reduce((sum, item) => sum + item.x, 0) / items.length
  const my = items.reduce((sum, item) => sum + value(item), 0) / items.length
  const sxx = items.reduce((sum, item) => sum + (item.x - mx) ** 2, 0)
  const slope = sxx ? items.reduce((sum, item) => sum + (item.x - mx) * (value(item) - my), 0) / sxx : 0
  return (x: number) => my + slope * (x - mx)
}

/**
 * Estimates humanoid rig landmarks from mesh geometry in the import-normalized preview frame. `rotation` is the
 * setup rotation; returned landmarks use the rig-stage frame that the viewport displays.
 */
export function fitLandmarks(geometry: MeshGeometry, rotation: Vec3): LandmarkFit {
  if (geometry.positions.length < 9 || geometry.positions.length % 3 || geometry.indices.length < 3 || geometry.indices.length % 3)
    throw new LandmarkFitError('Mesh has no triangle geometry to fit.')
  const positions = orientGeometry(geometry, rotation)
  const points = samplePoints(positions, geometry.indices)
  const index = new PointIndex(points)
  const silhouette = new Silhouette(points)
  const warnings: string[] = [], measurements: Record<string, number> = {}
  const row = (y: number) => silhouette.row(y), col = (x: number) => silhouette.col(x)
  const result: Landmarks = {}

  // Torso centerline from the body run around the waist.
  const x0 = median([0.95, 1.05, 1.15, 1.25, 1.35].map(y => {
    const match = nearestRun(silhouette.rowRuns(row(y)), col(0))
    return match ? (silhouette.x(match.run[0]) + silhouette.x(match.run[1])) / 2 : Number.NaN
  }))
  if (!Number.isFinite(x0)) throw new LandmarkFitError('Could not find a torso in the mesh silhouette.')
  const c0 = col(x0)

  // Crotch: top of the gap between the legs (often the bottom of shorts or trousers).
  const gapTops: number[] = []
  for (let c = c0 - 2; c <= c0 + 2; c++) {
    let best = 0, top = Number.NaN, start = -1
    for (let r = 0; r < silhouette.rows; r++) {
      if (!silhouette.filled(c, r)) { if (start < 0) start = r; continue }
      if (start >= 0 && r - start > best && start * CELL < 0.5) { best = r - start; top = r * CELL }
      start = -1
    }
    if (best * CELL >= 0.15) gapTops.push(top)
  }
  const gap = gapTops.length >= 3 ? median(gapTops) : Number.NaN
  const crotchFound = Number.isFinite(gap) && gap >= 0.4 && gap <= 1.3
  if (crotchFound) measurements.crotch = gap
  const armMinY = crotchFound ? gap + 0.15 : 0.95

  // Arms: trace each arm inward from its extreme point; the armpit is where the arm's lower edge turns down.
  const arms = new Map<string, { y: number }>()
  for (const [side, s] of SIDES) {
    let tip: Vec3 | undefined
    for (let i = 0; i < points.length; i += 3)
      if (points[i + 1] > armMinY && (!tip || s * points[i] > s * tip[0])) tip = [points[i], points[i + 1], points[i + 2]]
    if (!tip || s * (tip[0] - x0) < 0.3) throw new LandmarkFitError(`Could not find the ${side.toLowerCase()} arm. Auto-fit needs arms held away from the body (T-pose or A-pose).`)
    const trace: ArmColumn[] = []
    let previous = row(tip[1]), gaps = 0
    for (let c = col(tip[0]) - s * 2; s * (c - c0) > 2; c -= s) {
      const match = nearestRun(silhouette.columnRuns(c).filter(run => (run[1] + 1) * CELL > armMinY), previous)
      if (!match || match.distance > 4) { if (++gaps > 3) break; continue }
      gaps = 0
      trace.push({ col: c, x: silhouette.x(c), bottom: match.run[0] * CELL, top: (match.run[1] + 1) * CELL })
      previous = Math.round((match.run[0] + match.run[1]) / 2)
    }
    const zone = 0.55 * s * (tip[0] - x0)
    let armpit = -1, bottomAt = (_x: number) => Number.NaN
    for (let i = 12; i < trace.length && armpit < 0; i++) {
      if (s * (trace[i].x - x0) > zone) continue
      const base = trace.slice(i - 12, i - 2), expected = lineFit(base, item => item.bottom)
      const thickness = median(base.map(item => item.top - item.bottom))
      const deviation = (k: number) => expected(trace[k].x) - trace[k].bottom
      const soft = Math.max(0.03, 0.25 * thickness)
      if (deviation(i) > Math.max(0.08, 0.6 * thickness) || (i + 1 < trace.length && deviation(i) > soft && deviation(i + 1) > soft)) {
        armpit = i
        bottomAt = expected
      }
    }
    if (armpit < 0) {
      armpit = trace.findIndex(item => s * (item.x - x0) <= 0.25 * s * (tip![0] - x0))
      if (armpit < 12) throw new LandmarkFitError(`Could not separate the ${side.toLowerCase()} arm from the torso. Auto-fit needs arms held away from the body (T-pose or A-pose).`)
      bottomAt = lineFit(trace.slice(armpit - 12, armpit - 2), item => item.bottom)
      warnings.push(`Could not find the ${side.toLowerCase()} armpit; the ${side.toLowerCase()} shoulder uses arm-span proportions. Check the ${side.toLowerCase()} arm.`)
    }
    const arm = trace.slice(0, armpit), armX = trace[armpit].x
    const span = (t: number) => lerp(armX, tip![0], t)
    const at = (x: number) => arm.reduce((best, item) => Math.abs(item.x - x) < Math.abs(best.x - x) ? item : best, arm[0])
    const section = (x: number) => {
      const item = at(x)
      return { item, box: index.box(item.bottom - CELL, item.top + CELL, px => Math.abs(px - item.x) <= CELL) }
    }
    const midThickness = median(arm.filter(item => s * (item.x - span(0.3)) >= 0 && s * (item.x - span(0.6)) <= 0).map(item => item.top - item.bottom))
    const armY = bottomAt(armX) + 0.6 * (Number.isFinite(midThickness) ? midThickness : 0.1)
    const armSection = section(armX + s * 0.04)
    const armZ = armSection.box.n >= 4 ? center(armSection.box)[2] : 0
    measurements[`${side}Armpit`] = armX
    measurements[`${side}ArmTip`] = tip[0]

    // Wrist: where the cross-section's major axis widens sharply into the hand (palm-down or palm-forward);
    // otherwise use typical hand proportions.
    const sizes = arm.filter(item => s * (item.x - span(0.45)) >= 0 && s * (item.x - span(0.95)) <= 0).reverse().map(item => {
      const box = index.box(item.bottom - CELL, item.top + CELL, px => Math.abs(px - item.x) <= CELL)
      return { x: item.x, size: box.n >= 4 ? Math.max(item.top - item.bottom, box.maxZ - box.minZ) : Number.NaN }
    }).filter(entry => Number.isFinite(entry.size))
    const smooth = sizes.map((_, i) => median(sizes.slice(Math.max(0, i - 1), i + 2).map(entry => entry.size)))
    let wristX = span(WRIST_FRACTION), widening = WRIST_WIDENING
    sizes.forEach((entry, i) => {
      const t = (entry.x - armX) / (tip![0] - armX), ahead = sizes.findIndex(item => s * (item.x - entry.x) >= 0.04)
      if (t < 0.5 || t > 0.88 || ahead < 0) return
      const ratio = smooth[ahead] / smooth[i]
      if (ratio > widening) { widening = ratio; wristX = entry.x }
    })
    measurements[`${side}Wrist`] = wristX
    const landmarkAt = (x: number): Vec3 => {
      const { item, box } = section(x)
      return [item.x, (item.bottom + item.top) / 2, box.n >= 4 ? center(box)[2] : armZ]
    }
    result[`${side}Arm`] = [armX, armY, armZ]
    result[`${side}ForeArm`] = landmarkAt(lerp(armX, wristX, ELBOW_FRACTION))
    result[`${side}Hand`] = landmarkAt(wristX)
    result[`${side}HandEnd`] = landmarkAt(lerp(wristX, tip[0], HAND_END_FRACTION))
    arms.set(side, { y: armY })
  }
  const armLine = (arms.get('Left')!.y + arms.get('Right')!.y) / 2
  let hipY = HIP_TO_ARM_RATIO * armLine
  if (crotchFound) hipY = clamp(hipY, gap + 0.05, gap + 0.4)
  else warnings.push('Could not find a gap between the legs; hip height uses body proportions. Check the hips and legs.')
  const crotchY = crotchFound ? gap : hipY - 0.1
  measurements.hip = hipY

  // Legs: follow each leg's silhouette run downward from the crotch.
  for (const [side, s] of SIDES) {
    const runs = new Map<number, Run>()
    let previous = c0 + s * Math.round(0.12 / CELL)
    for (let r = row(crotchY) - 2; r >= 0; r--) {
      const clipped = silhouette.rowRuns(r)
        .map(([a, b]): Run | undefined => s > 0 ? (b > c0 ? [Math.max(a, c0 + 1), b] : undefined) : (a < c0 ? [a, Math.min(b, c0 - 1)] : undefined))
        .filter((run): run is Run => !!run)
      const match = nearestRun(clipped, previous)
      if (!match || match.distance > 6) continue
      runs.set(r, match.run)
      previous = Math.round((match.run[0] + match.run[1]) / 2)
    }
    if (runs.size < (crotchY - 0.2) / CELL) throw new LandmarkFitError(`Could not trace the ${side.toLowerCase()} leg. Auto-fit needs a standing humanoid with separated legs.`)
    const leg = (y0: number, y1: number, keep: (x: number, y: number, z: number) => boolean = () => true) => index.box(y0, y1, (x, y, z) => {
      const run = runs.get(row(y))
      return !!run && x >= silhouette.x(run[0]) - CELL && x <= silhouette.x(run[1]) + CELL && keep(x, y, z)
    })
    const upper = leg(crotchY - 0.08, crotchY - 0.04), lower = leg(crotchY - 0.26, crotchY - 0.22)
    if (upper.n < 8 || lower.n < 8) throw new LandmarkFitError(`Could not measure the ${side.toLowerCase()} thigh.`)
    const [ux, , uz] = center(upper), [lx] = center(lower)
    const outward = s * (ux - lx) / 0.18
    const hipX = x0 + s * clamp(s * (ux - x0) + outward * Math.min(hipY - (crotchY - 0.06), 0.1), 0.04, s * (ux - x0) + 0.02)

    // Ankle: lowest height where the leg's front-back depth falls back toward the shin's depth.
    const depth = (y: number) => { const b = leg(y - 0.015, y + 0.015); return b.n >= 4 ? b.maxZ - b.minZ : Number.NaN }
    const footLength = Math.max(...[0.02, 0.04, 0.06].map(depth).filter(Number.isFinite))
    const shinDepth = median([0.3, 0.33, 0.36, 0.39, 0.42].map(depth))
    let footY = Number.NaN
    if (Number.isFinite(footLength) && Number.isFinite(shinDepth) && footLength - shinDepth > 0.04) {
      const threshold = shinDepth + ANKLE_DEPTH_FRACTION * (footLength - shinDepth)
      for (let y = 0.04; y <= 0.32; y += CELL)
        if ([0, 1, 2].every(k => depth(y + k * CELL) <= threshold)) { footY = clamp(y, 0.06, 0.25); break }
    }
    if (!Number.isFinite(footY)) {
      footY = 0.12
      warnings.push(`Could not find the ${side.toLowerCase()} ankle from the foot shape; check the ${side.toLowerCase()} foot and toes.`)
    }
    const shinBottom = leg(footY + 0.03, footY + 0.07)
    const [fx, , fz] = shinBottom.n >= 4 ? center(shinBottom) : center(leg(footY - 0.01, footY + 0.01))
    const kneeY = lerp(footY, hipY, 0.5)
    const knee = leg(kneeY - 0.02, kneeY + 0.02)
    if (knee.n < 8) throw new LandmarkFitError(`Could not measure the ${side.toLowerCase()} knee.`)
    const [kx, , kz] = center(knee)

    const foot = leg(0, footY)
    if (foot.n < 8) throw new LandmarkFitError(`Could not measure the ${side.toLowerCase()} foot.`)
    const tipZ = foot.maxZ
    const toeAt = (z: number): Vec3 => {
      const b = leg(0, footY, (_x, _y, pz) => Math.abs(pz - z) <= 0.015)
      return b.n >= 4 ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, z] : [fx, Math.min(0.055, footY / 2), z]
    }
    const toeEndZ = tipZ - Math.max(0.02, TOE_END_INSET * (tipZ - fz))
    const toeBaseZ = Math.min(fz + TOE_BASE_FRACTION * (tipZ - fz), toeEndZ - 0.03)
    measurements[`${side}Ankle`] = footY
    measurements[`${side}ToeTip`] = tipZ

    result[`${side}Leg`] = [hipX, hipY, uz]
    result[`${side}Shin`] = [kx, kneeY, kz + KNEE_FORWARD]
    result[`${side}Foot`] = [fx, footY, fz]
    result[`${side}ToeBase`] = toeAt(toeBaseZ)
    result[`${side}ToeEnd`] = toeAt(toeEndZ)
  }

  // Neck: the narrowest central run between the shoulders and the widest part of the head.
  const top = Math.max(result.LeftArm[1], result.RightArm[1])
  const widths = new Map<number, number>()
  for (let r = row(top + 0.03); r <= row(HEIGHT - 0.04); r++) {
    const match = nearestRun(silhouette.rowRuns(r), c0)
    widths.set(r, match ? (match.run[1] - match.run[0] + 1) * CELL : Infinity)
  }
  const width = (r: number) => median([widths.get(r - 1) ?? Infinity, widths.get(r) ?? Infinity, widths.get(r + 1) ?? Infinity])
  let headWide = row(HEIGHT - 0.04)
  for (let r = row(lerp(top, HEIGHT, 0.5)); r <= row(HEIGHT - 0.04); r++) if (width(r) > width(headWide)) headWide = r
  let neckRow = row(top + 0.03)
  for (let r = neckRow; r < headWide; r++) if (width(r) < width(neckRow)) neckRow = r
  const neckY = (neckRow + 0.5) * CELL
  measurements.neck = neckY

  const central = (y: number): Vec3 => {
    const box = index.box(y - 0.02, y + 0.02, x => Math.abs(x - x0) <= 0.06)
    return [x0, y, box.n >= 4 ? center(box)[2] : 0]
  }
  const hipsY = hipY + HIPS_ABOVE_LEGS
  const neck1Y = Math.max(neckY - 0.07, lerp(armLine, neckY, 0.5))
  const headY = neckY + 0.045
  result.Hips = central(hipsY)
  result.Spine1 = central(lerp(hipsY, neck1Y, 0.25))
  result.Spine2 = central(lerp(hipsY, neck1Y, 0.53))
  result.Chest = central(lerp(hipsY, neck1Y, 0.75))
  result.Neck1 = central(neck1Y)
  result.Head = central(headY)
  result.HeadEnd = central(lerp(headY, HEIGHT, 0.8))
  for (const [side] of SIDES) {
    const arm = result[`${side}Arm`]
    result[`${side}Shoulder`] = [lerp(x0, arm[0], 0.4), arm[1] + 0.015, (arm[2] + result.Chest[2]) / 2]
  }

  // Mirror sides when they agree closely so small mesh asymmetries do not skew the rig.
  for (const name of Object.keys(result).filter(key => key.startsWith('Left'))) {
    const other = `Right${name.slice(4)}`, left = result[name], right = result[other]
    const mirrored: Vec3 = [2 * x0 - right[0], right[1], right[2]]
    if (left.every((value, axis) => Math.abs(value - mirrored[axis]) <= SYMMETRY_TOLERANCE)) {
      const average = left.map((value, axis) => (value + mirrored[axis]) / 2) as Vec3
      result[name] = average
      result[other] = [2 * x0 - average[0], average[1], average[2]]
    }
  }

  // Keep landmarks enclosed by the surface: try the local cross-section center, then pull end joints toward their parent.
  const names = Object.keys(result)
  const enclosed = enclosedPoints(positions, geometry.indices, names.map(name => result[name]))
  const parents = new Map(boneLinks.map(([parent, child]) => [child, parent]))
  const candidates = names.filter((_, i) => !enclosed[i]).flatMap(name => {
    const [px, py, pz] = result[name]
    const box = index.box(py - 0.04, py + 0.04, (x, _y, z) => Math.hypot(x - px, z - pz) <= 0.08)
    const options: Vec3[] = box.n >= 4 ? [center(box)] : []
    const parent = parents.get(name)
    if (parent && !boneLinks.some(([from]) => from === name))
      for (const t of [0.85, 0.7, 0.55]) options.push(result[name].map((value, axis) => lerp(result[parent][axis], value, t)) as Vec3)
    return options.map(point => ({ name, point }))
  })
  const accepted = enclosedPoints(positions, geometry.indices, candidates.map(candidate => candidate.point))
  const moved = new Set<string>()
  candidates.forEach((candidate, i) => {
    if (!accepted[i] || moved.has(candidate.name)) return
    result[candidate.name] = candidate.point
    moved.add(candidate.name)
  })
  const outside = names.filter((name, i) => !enclosed[i] && !moved.has(name))

  const landmarks = Object.fromEntries(names.map(name => [name, result[name].map(round) as Vec3])) as Landmarks
  validateFit(landmarks)
  if (outside.length)
    warnings.push(`Auto-fit could not place ${outside.join(', ')} inside the mesh; adjust ${outside.length === 1 ? 'it' : 'them'} before skinning.`)
  for (const key of Object.keys(measurements)) measurements[key] = round(measurements[key])
  return { landmarks, warnings, outside, measurements }
}

function validateFit(landmarks: Landmarks) {
  const spine = ['Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Head', 'HeadEnd']
  for (let k = 1; k < spine.length; k++)
    if (landmarks[spine[k]][1] <= landmarks[spine[k - 1]][1])
      throw new LandmarkFitError('Auto-fit produced out-of-order spine joints; place the landmarks manually for this mesh.')
  for (const [side, s] of SIDES) {
    const leg = [`${side}Leg`, `${side}Shin`, `${side}Foot`]
    for (let k = 1; k < leg.length; k++)
      if (landmarks[leg[k]][1] >= landmarks[leg[k - 1]][1])
        throw new LandmarkFitError(`Auto-fit produced out-of-order ${side.toLowerCase()} leg joints; place the landmarks manually for this mesh.`)
    const arm = [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`, `${side}HandEnd`]
    for (let k = 1; k < arm.length; k++)
      if (s * (landmarks[arm[k]][0] - landmarks[arm[k - 1]][0]) <= 0)
        throw new LandmarkFitError(`Auto-fit produced out-of-order ${side.toLowerCase()} arm joints; place the landmarks manually for this mesh.`)
  }
  for (const [from, to] of boneLinks) {
    const a = landmarks[from], b = landmarks[to]
    if (!a || !b || Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.03)
      throw new LandmarkFitError(`Auto-fit produced a too-short ${from} to ${to} bone; place the landmarks manually for this mesh.`)
  }
}

// Proportions calibrated against hand-fitted and generated humanoid meshes in the normalized 2 m frame.
const HIP_TO_ARM_RATIO = 0.645
const HIPS_ABOVE_LEGS = 0.035
const ANKLE_DEPTH_FRACTION = 0.35
const TOE_BASE_FRACTION = 0.55
const TOE_END_INSET = 0.1
const KNEE_FORWARD = 0.01
const ELBOW_FRACTION = 0.52
const WRIST_FRACTION = 0.76
const WRIST_WIDENING = 1.25
const HAND_END_FRACTION = 0.75
const SYMMETRY_TOLERANCE = 0.04