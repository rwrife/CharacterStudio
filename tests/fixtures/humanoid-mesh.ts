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
