import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { fingerChains, handPrefix, handSides, handTemplate } from '../../src/shared/hand-rig'
import { defaultLandmarks } from '../../src/shared/rig'
import type { RigSetup } from '../../src/shared/types'

// Procedural test-only humanoid made from closed boxes. It is not a production asset.
export interface BoxMesh { positions: Float32Array; indices: Uint32Array }
type Box = [number, number, number, number, number, number]

const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]]

export function boxMesh(boxes: Box[]): BoxMesh {
  const positions: number[] = [], indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    positions.push(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1)
    for (const face of faces) indices.push(...face.map(i => base + i))
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

/** A 2 m T-pose humanoid in the import frame: Y-up, facing +Z, character left at +X. */
export function boxHumanoid(): BoxMesh {
  const boxes: Box[] = [
    [-0.2, 0.9, -0.12, 0.2, 1.6, 0.12],
    [-0.05, 1.58, -0.05, 0.05, 1.72, 0.05],
    [-0.1, 1.7, -0.11, 0.1, 2, 0.11]
  ]
  for (const s of [1, -1]) {
    const x = (a: number, b: number): [number, number] => s > 0 ? [a, b] : [-b, -a]
    const [legA, legB] = x(0.05, 0.19), [footA, footB] = x(0.06, 0.18)
    const [armA, armB] = x(0.18, 0.78), [handA, handB] = x(0.76, 0.95)
    boxes.push(
      [legA, 0.08, -0.07, legB, 0.95, 0.07],
      [footA, 0, -0.07, footB, 0.1, 0.2],
      [armA, 1.45, -0.05, armB, 1.55, 0.05],
      [handA, 1.42, -0.04, handB, 1.58, 0.04]
    )
  }
  return boxMesh(boxes)
}

/** Encodes triangles as a minimal binary glTF 2 file under an optional parent node transform. */
export function encodeGlb(mesh: BoxMesh, parent: { scale?: number; translation?: [number, number, number] } = {}, indexType: 'u16' | 'u32' = 'u32'): Buffer {
  const indexBytes = indexType === 'u16' ? Buffer.from(new Uint16Array(mesh.indices).buffer) : Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength)
  const positionBytes = Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength)
  const padding = (4 - indexBytes.length % 4) % 4
  const binary = Buffer.concat([positionBytes, indexBytes, Buffer.alloc(padding)])
  const min = [0, 1, 2].map(axis => Math.min(...mesh.positions.filter((_, i) => i % 3 === axis)))
  const max = [0, 1, 2].map(axis => Math.max(...mesh.positions.filter((_, i) => i % 3 === axis)))
  const transform = { ...(parent.scale ? { scale: [parent.scale, parent.scale, parent.scale] } : {}), ...(parent.translation ? { translation: parent.translation } : {}) }
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ children: [1], ...transform }, { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBytes.length }, { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: indexType === 'u16' ? 5123 : 5125, count: mesh.indices.length, type: 'SCALAR' }
    ]
  }))
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)])
  const header = Buffer.alloc(12)
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binary.length, 8)
  const chunk = (data: Buffer, type: string) => { const head = Buffer.alloc(8); head.writeUInt32LE(data.length, 0); head.write(type, 4); return Buffer.concat([head, data]) }
  return Buffer.concat([header, chunk(jsonChunk, 'JSON'), chunk(binary, 'BIN\0')])
}

/** Three-joint procedural skin for observing wrist controls, not automatic skinning quality. */
export function basicHandSetup(): RigSetup {
  const setup: RigSetup = { rotation: [0, 0, 0], landmarks: defaultLandmarks() }
  for (const [prefix, sign] of [['Left', 1], ['Right', -1]] as const) {
    setup.landmarks[`${prefix}Hand`] = [sign * 0.76, 1.5, 0]
    setup.landmarks[`${prefix}HandEnd`] = [sign * 0.98, 1.5, 0]
  }
  return handTemplate(handTemplate(setup, 'left', 'basic'), 'right', 'basic')
}

export function encodeWristFixture(animated = false, setup?: RigSetup): Buffer {
  let mesh = boxHumanoid()
  const bodyCount = mesh.positions.length / 3
  if (setup) {
    for (const box of [6, 10]) for (let vertex = box * 8; vertex < box * 8 + 8; vertex++) {
      mesh.positions[vertex * 3] = Math.sign(mesh.positions[vertex * 3]) * (0.76 + (Math.abs(mesh.positions[vertex * 3]) - 0.76) * 0.11 / 0.19)
      mesh.positions[vertex * 3 + 1] = 1.5 + (mesh.positions[vertex * 3 + 1] - 1.5) * 0.25
    }
    const boxes: Box[] = []
    for (const side of handSides) for (const chain of fingerChains) for (let i = 0; i < chain.segments; i++) {
      const a = setup.landmarks[`${handPrefix(side)}${chain.name}${i + 1}`]
      const b = setup.landmarks[`${handPrefix(side)}${chain.name}${i + 2}`]
      const radius = chain.name === 'Fingers' ? 0.018 : 0.009
      boxes.push([Math.min(a[0], b[0]), a[1] - 0.009, Math.min(a[2], b[2]) - radius,
        Math.max(a[0], b[0]), a[1] + 0.009, Math.max(a[2], b[2]) + radius])
    }
    const fingers = boxMesh(boxes)
    mesh = { positions: new Float32Array([...mesh.positions, ...fingers.positions]),
      indices: new Uint32Array([...mesh.indices, ...fingers.indices.map(index => index + bodyCount)]) }
  }
  const original = encodeGlb(mesh)
  const jsonLength = original.readUInt32LE(12)
  const gltf = JSON.parse(original.subarray(20, 20 + jsonLength).toString())
  let binary = original.subarray(28 + jsonLength)
  const append = (data: Float32Array | Uint16Array, type: string, count: number) => {
    const index = gltf.accessors.length
    gltf.accessors.push({ bufferView: gltf.bufferViews.length, componentType: data instanceof Float32Array ? 5126 : 5123, count, type })
    gltf.bufferViews.push({ buffer: 0, byteOffset: binary.length, byteLength: data.byteLength })
    binary = Buffer.concat([binary, Buffer.from(data.buffer), Buffer.alloc((4 - data.byteLength % 4) % 4)])
    return index
  }
  const count = mesh.positions.length / 3, joints = new Uint16Array(count * 4), weights = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const box = Math.floor(i / 8)
    joints[i * 4] = i >= bodyCount ? 3 + Math.floor((i - bodyCount) / 8) : box === 6 ? 1 : box === 10 ? 2 : 0
    weights[i * 4] = 1
  }
  const left = new Quaternion().setFromEuler(new Euler(0.2, 0.3, -1.2))
  const right = new Quaternion().setFromEuler(new Euler(-0.2, 0.1, 1.2))
  const inverse = [
    new Matrix4(),
    new Matrix4().compose(new Vector3(0.76, 1.5, 0), left, new Vector3(1, 1, 1)).invert(),
    new Matrix4().compose(new Vector3(-0.76, 1.5, 0), right, new Vector3(1, 1, 1)).invert()
  ]
  Object.assign(gltf.meshes[0].primitives[0].attributes, {
    JOINTS_0: append(joints, 'VEC4', count), WEIGHTS_0: append(weights, 'VEC4', count)
  })
  gltf.nodes = [
    { children: [1, 2] }, { mesh: 0, skin: 0 }, { name: 'Hips', children: [3, 4] },
    { name: 'LeftHand', translation: [0.76, 1.5, 0], rotation: left.toArray() },
    { name: 'RightHand', translation: [-0.76, 1.5, 0], rotation: right.toArray() }
  ]
  if (setup) {
    const worlds = new Map<string, Matrix4>([['LeftHand', inverse[1].clone().invert()], ['RightHand', inverse[2].clone().invert()]])
    for (const side of handSides) for (const chain of fingerChains) for (let i = 0; i < chain.segments; i++) {
      const prefix = handPrefix(side), name = `${prefix}${chain.name}${i + 1}`
      const head = new Vector3(...setup.landmarks[name]), tail = new Vector3(...setup.landmarks[`${prefix}${chain.name}${i + 2}`])
      const y = tail.sub(head).normalize(), z = new Vector3(0, 1, 0), x = y.clone().cross(z).normalize()
      z.crossVectors(x, y).normalize()
      const world = new Matrix4().makeBasis(x, y, z).setPosition(head)
      const parent = i === 0 ? `${prefix}Hand` : `${prefix}${chain.name}${i}`
      const local = worlds.get(parent)!.clone().invert().multiply(world)
      const parentNode = gltf.nodes.find((node: { name?: string }) => node.name === parent)
      parentNode.children ??= []
      parentNode.children.push(gltf.nodes.length)
      gltf.nodes.push({ name, matrix: local.toArray() })
      worlds.set(name, world)
      inverse.push(world.clone().invert())
    }
  }
  gltf.skins = [{ joints: Array.from({ length: inverse.length }, (_, i) => i + 2),
    inverseBindMatrices: append(new Float32Array(inverse.flatMap(m => m.toArray())), 'MAT4', inverse.length) }]
  if (animated) {
    const input = append(new Float32Array([0, 1]), 'SCALAR', 2)
    Object.assign(gltf.accessors[input], { min: [0], max: [1] })
    const output = append(new Float32Array([...left.toArray(), ...left.toArray()]), 'VEC4', 2)
    gltf.animations = [{ samplers: [{ input, output, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 3, path: 'rotation' } }] }]
  }
  gltf.buffers[0].byteLength = binary.length
  const raw = Buffer.from(JSON.stringify(gltf)), json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)])
  const result = Buffer.alloc(28 + json.length + binary.length)
  result.write('glTF'); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8)
  result.writeUInt32LE(json.length, 12); result.write('JSON', 16); json.copy(result, 20)
  result.writeUInt32LE(binary.length, 20 + json.length); result.write('BIN\0', 24 + json.length); binary.copy(result, 28 + json.length)
  return result
}
