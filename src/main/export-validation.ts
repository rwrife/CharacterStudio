import { readFile } from 'node:fs/promises'

interface Gltf {
  skins?: { joints: number[] }[]
  nodes?: { mesh?: number; skin?: number }[]
  meshes?: { primitives: { attributes: Record<string, number> }[] }[]
  animations?: { channels: { target: { node: number; path: string } }[] }[]
}

export async function validateCharacterGlb(path: string, animated: boolean): Promise<void> {
  const bytes = await readFile(path)
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a)
    throw new Error('Character export is not a complete binary glTF 2 file.')
  const length = bytes.readUInt32LE(12)
  if (length > bytes.length - 20) throw new Error('Truncated GLB JSON chunk.')
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString()) as Gltf
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
