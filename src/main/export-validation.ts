import { readFile } from 'node:fs/promises'

interface Gltf {
  asset?: { version?: string }
  buffers?: { uri?: string; byteLength: number }[]
  images?: { uri?: string }[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[]
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }[]
  skins?: { joints: number[] }[]
  nodes?: { mesh?: number; skin?: number }[]
  meshes?: { primitives: { attributes: Record<string, number> }[] }[]
  animations?: { channels: { target: { node: number; path: string } }[] }[]
}

async function readGlb(path: string) {
  const bytes = await readFile(path)
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a)
    throw new Error('Character export is not a complete binary glTF 2 file.')
  const length = bytes.readUInt32LE(12)
  if (length > bytes.length - 20) throw new Error('Truncated GLB JSON chunk.')
  return { gltf: JSON.parse(bytes.subarray(20, 20 + length).toString()) as Gltf, bytes, binaryOffset: 20 + length }
}

export async function validateDesignGlb(path: string): Promise<void> {
  const { gltf, bytes, binaryOffset } = await readGlb(path)
  if (gltf.asset?.version !== '2.0' || gltf.buffers?.length !== 1 || gltf.buffers[0].uri ||
      gltf.images?.some(image => image.uri) || binaryOffset + 8 > bytes.length ||
      bytes.readUInt32LE(binaryOffset + 4) !== 0x004e4942 ||
      binaryOffset + 8 + bytes.readUInt32LE(binaryOffset) !== bytes.length ||
      gltf.buffers[0].byteLength > bytes.readUInt32LE(binaryOffset))
    throw new Error('Generated GLB must contain complete embedded geometry without external resources.')
  const nodes = gltf.nodes?.filter(node => node.mesh !== undefined) ?? []
  if (!nodes.length) throw new Error('Generated model contains no mesh geometry.')
  for (const node of nodes) {
    const primitives = gltf.meshes?.[node.mesh!]?.primitives
    if (!primitives?.length) throw new Error('Generated model has no mesh primitives.')
    for (const primitive of primitives) {
      const position = gltf.accessors?.[primitive.attributes.POSITION]
      const view = position?.bufferView === undefined ? undefined : gltf.bufferViews?.[position.bufferView]
      const stride = view?.byteStride ?? 12
      const offset = (view?.byteOffset ?? 0) + (position?.byteOffset ?? 0)
      if (!position || position.type !== 'VEC3' || position.componentType !== 5126 || !Number.isSafeInteger(position.count) || position.count < 3 ||
          !view || view.buffer !== 0 || !Number.isSafeInteger(offset) || offset < 0 || stride < 12 ||
          (position.byteOffset ?? 0) + (position.count - 1) * stride + 12 > view.byteLength ||
          (view.byteOffset ?? 0) + view.byteLength > gltf.buffers[0].byteLength)
        throw new Error('Generated model has incomplete vertex geometry.')
    }
  }
}

export async function validateCharacterGlb(path: string, animated: boolean): Promise<void> {
  const { gltf } = await readGlb(path)
  const characters = gltf.nodes?.filter(node => node.mesh !== undefined) ?? []
  if (!characters.length) throw new Error('Export contains no character mesh.')
  for (const node of characters) {
    const skin = node.skin === undefined ? undefined : gltf.skins?.[node.skin]
    const mesh = gltf.meshes?.[node.mesh!]
    if (!skin?.joints.length || !mesh?.primitives.length || mesh.primitives.some(p =>
      !['POSITION', 'JOINTS_0', 'WEIGHTS_0'].every(key => key in p.attributes)))
      throw new Error('Export contains an unskinned mesh. Refusing a completed character result.')
    if (animated && !gltf.animations?.some(a => a.channels.some(c =>
      c.target.path === 'rotation' && skin.joints.includes(c.target.node))))
      throw new Error('Export contains no skeletal rotation animation on the character.')
  }
}
