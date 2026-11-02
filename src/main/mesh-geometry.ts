import { readGlb, type Gltf } from './export-validation'
import type { MeshGeometry } from '../shared/landmark-fit'

const MAX_VERTICES = 8_000_000
const MAX_TRIANGLES = 16_000_000
type Matrix = number[]

const identity = (): Matrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16).fill(0)
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k]
  return out
}

function localMatrix(node: NonNullable<Gltf['nodes']>[number]): Matrix {
  if (node.matrix) {
    if (node.matrix.length !== 16 || !node.matrix.every(Number.isFinite)) throw new Error('Mesh preview has an invalid node matrix.')
    return node.matrix
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  if (![tx, ty, tz, x, y, z, w, sx, sy, sz].every(Number.isFinite)) throw new Error('Mesh preview has an invalid node transform.')
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1
  ]
}

/** Reads the triangle geometry of an embedded-buffer GLB in scene (world) coordinates. */
export async function readGlbGeometry(path: string): Promise<MeshGeometry> {
  let glb: Awaited<ReturnType<typeof readGlb>>
  try { glb = await readGlb(path) } catch { throw new Error('Mesh preview is not a complete binary glTF 2 file.') }
  const { gltf, bytes, binaryOffset } = glb
  if (binaryOffset + 8 > bytes.length || bytes.readUInt32LE(binaryOffset + 4) !== 0x004e4942)
    throw new Error('Mesh preview has no embedded binary geometry.')
  const binaryLength = bytes.readUInt32LE(binaryOffset)
  if (binaryOffset + 8 + binaryLength > bytes.length || gltf.buffers?.length !== 1 || gltf.buffers[0].uri ||
      gltf.buffers[0].byteLength > binaryLength)
    throw new Error('Mesh preview must embed its geometry in a single binary buffer.')
  const binary = bytes.subarray(binaryOffset + 8, binaryOffset + 8 + binaryLength)

  const accessor = (index: number, kind: 'position' | 'index') => {
    const item = gltf.accessors?.[index]
    const view = item?.bufferView === undefined ? undefined : gltf.bufferViews?.[item.bufferView]
    const size = kind === 'position' ? (item?.componentType === 5126 ? 4 : 0)
      : ({ 5121: 1, 5123: 2, 5125: 4 } as Record<number, number | undefined>)[item?.componentType ?? 0] ?? 0
    const width = kind === 'position' ? 3 : 1
    const stride = view?.byteStride ?? size * width
    const start = (view?.byteOffset ?? 0) + (item?.byteOffset ?? 0)
    if (!item || !view || item.sparse || !size || item.type !== (kind === 'position' ? 'VEC3' : 'SCALAR') || view.buffer !== 0 ||
        !Number.isSafeInteger(item.count) || item.count < (kind === 'position' ? 3 : 0) || !Number.isSafeInteger(start) || start < 0 ||
        stride < size * width || (item.byteOffset ?? 0) + Math.max(0, item.count - 1) * stride + size * width > view.byteLength ||
        (view.byteOffset ?? 0) + view.byteLength > binary.length)
      throw new Error(`Mesh preview has incomplete ${kind === 'position' ? 'vertex positions' : 'triangle indices'}.`)
    return { count: item.count, start, stride, size }
  }

  const parts: { positions: Float32Array; indices: Uint32Array }[] = []
  let vertexTotal = 0, triangleTotal = 0
  const nodes = gltf.nodes ?? []
  const children = new Set(nodes.flatMap(node => node.children ?? []))
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? nodes.map((_, index) => index).filter(index => !children.has(index))
  const visited = new Set<number>()
  const visit = (index: number, parent: Matrix) => {
    const node = nodes[index]
    if (!node || visited.has(index)) throw new Error('Mesh preview has an invalid node hierarchy.')
    visited.add(index)
    const world = multiply(parent, localMatrix(node))
    for (const primitive of node.mesh === undefined ? [] : gltf.meshes?.[node.mesh]?.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4 || primitive.attributes.POSITION === undefined) continue
      const position = accessor(primitive.attributes.POSITION, 'position')
      const positions = new Float32Array(position.count * 3)
      for (let vertex = 0; vertex < position.count; vertex++) {
        const offset = position.start + vertex * position.stride
        const x = binary.readFloatLE(offset), y = binary.readFloatLE(offset + 4), z = binary.readFloatLE(offset + 8)
        positions[vertex * 3] = world[0] * x + world[4] * y + world[8] * z + world[12]
        positions[vertex * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13]
        positions[vertex * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14]
      }
      let indices: Uint32Array
      if (primitive.indices === undefined) indices = Uint32Array.from({ length: position.count - position.count % 3 }, (_, i) => i)
      else {
        const index = accessor(primitive.indices, 'index')
        indices = new Uint32Array(index.count - index.count % 3)
        for (let i = 0; i < indices.length; i++) {
          const offset = index.start + i * index.stride
          const value = index.size === 1 ? binary[offset] : index.size === 2 ? binary.readUInt16LE(offset) : binary.readUInt32LE(offset)
          if (value >= position.count) throw new Error('Mesh preview has out-of-range triangle indices.')
          indices[i] = value + vertexTotal
        }
      }
      if (primitive.indices === undefined) for (let i = 0; i < indices.length; i++) indices[i] += vertexTotal
      vertexTotal += position.count
      triangleTotal += indices.length / 3
      if (vertexTotal > MAX_VERTICES || triangleTotal > MAX_TRIANGLES) throw new Error('Mesh preview is too large to fit landmarks automatically.')
      parts.push({ positions, indices })
    }
    for (const child of node.children ?? []) visit(child, world)
  }
  for (const root of roots) visit(root, identity())
  if (!triangleTotal) throw new Error('Mesh preview contains no triangle geometry.')

  const positions = new Float32Array(vertexTotal * 3), indices = new Uint32Array(triangleTotal * 3)
  let vertexOffset = 0, indexOffset = 0
  for (const part of parts) {
    positions.set(part.positions, vertexOffset)
    indices.set(part.indices, indexOffset)
    vertexOffset += part.positions.length
    indexOffset += part.indices.length
  }
  if (!positions.every(Number.isFinite)) throw new Error('Mesh preview has non-finite vertex positions.')
  return { positions, indices }
}
