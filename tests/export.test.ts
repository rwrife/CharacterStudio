import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateCharacterGlb, validateDesignGlb } from '../src/main/export-validation'

function glb(json: object): Buffer {
  const data = JSON.stringify(json)
  const payload = Buffer.from(data.padEnd(Math.ceil(data.length / 4) * 4, ' '))
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(20 + payload.length, 8); header.writeUInt32LE(payload.length, 12)
  header.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([header, payload])
}
test('character export validation rejects skeleton-only, unskinned, and static outputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kimodo-export-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'fixture.glb')
  await writeFile(file, glb({ nodes: [{ name: 'SkeletonOnly' }] }))
  await assert.rejects(validateCharacterGlb(file, true), /no character mesh/)
  const mesh = { nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }
  await writeFile(file, glb(mesh))
  await assert.rejects(validateCharacterGlb(file, true), /unskinned/)
  const skinned = { nodes: [{ mesh: 0, skin: 0 }, {}], meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }], skins: [{ joints: [1] }] }
  await writeFile(file, glb(skinned))
  await validateCharacterGlb(file, false)
  await assert.rejects(validateCharacterGlb(file, true), /no skeletal rotation/)
  await writeFile(file, glb({ ...skinned, animations: [{ channels: [{ target: { node: 1, path: 'rotation' } }] }] }))
  await validateCharacterGlb(file, true)
})

test('designer accepts embedded geometry but rejects empty, external and truncated meshes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-geometry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'mesh.glb')
  const geometry = {
    asset: { version: '2.0' }, buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }]
  }
  async function write(json: object, length = 36) {
    const bytes = glb(json), binary = Buffer.alloc(8 + length)
    binary.writeUInt32LE(length, 0); binary.writeUInt32LE(0x004e4942, 4)
    bytes.writeUInt32LE(bytes.length + binary.length, 8)
    await writeFile(path, Buffer.concat([bytes, binary]))
  }
  await write(geometry)
  await validateDesignGlb(path)
  await write({ ...geometry, nodes: [] })
  await assert.rejects(validateDesignGlb(path), /no mesh geometry/)
  await write({ ...geometry, buffers: [{ byteLength: 36, uri: 'https://example.com/asset.bin' }] })
  await assert.rejects(validateDesignGlb(path), /without external/)
  await write({ ...geometry, images: [{ uri: 'file:///private.png' }] })
  await assert.rejects(validateDesignGlb(path), /without external/)
  await write({ ...geometry, accessors: [{ ...geometry.accessors[0], count: 200 }] })
  await assert.rejects(validateDesignGlb(path), /incomplete vertex/)
  await write(geometry, 8)
  await assert.rejects(validateDesignGlb(path), /complete embedded/)
})
