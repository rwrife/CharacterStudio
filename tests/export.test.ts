import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
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

test('textured outputs require complete UVs and correctly-sized embedded, decodable material maps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-textures-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'textured.glb')
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12)
    bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4); data.copy(bytes, 8)
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4)
    return bytes
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 40, 160, 80]))), chunk('IEND', Buffer.alloc(0))])
  const geometry = {
    asset: { version: '2.0' }, buffers: [{ byteLength: 60 + png.length }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: png.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 0 } } }],
    textures: [{ source: 0 }], images: [{ bufferView: 2, mimeType: 'image/png' }]
  }
  const write = async (json: object, image = png) => {
    const bytes = glb(json), payload = Buffer.alloc(Math.ceil((60 + image.length) / 4) * 4)
    image.copy(payload, 60)
    const binary = Buffer.alloc(8)
    binary.writeUInt32LE(payload.length); binary.writeUInt32LE(0x004e4942, 4)
    bytes.writeUInt32LE(bytes.length + 8 + payload.length, 8)
    await writeFile(file, Buffer.concat([bytes, binary, payload]))
  }
  await write(geometry)
  assert.equal(await validateDesignGlb(file, 1), true)
  await assert.rejects(validateDesignGlb(file, 1024), /1024x1024/)
  await write({ ...geometry, materials: [] })
  await assert.rejects(validateDesignGlb(file, 1), /without base-color textures/)
  await write({ ...geometry, materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }] })
  await assert.rejects(validateDesignGlb(file, 1), /metallic\/roughness/)
  await write({ ...geometry, accessors: [geometry.accessors[0], { ...geometry.accessors[1], count: 1 }] })
  await assert.rejects(validateDesignGlb(file, 1), /incomplete UV/)
  await write({ ...geometry, images: [{ uri: 'https://example.com/texture.png' }] })
  await assert.rejects(validateDesignGlb(file, 1), /without external/)
  await write({ ...geometry, bufferViews: [...geometry.bufferViews.slice(0, 2), { buffer: 0, byteOffset: 9999, byteLength: png.length }] })
  await assert.rejects(validateDesignGlb(file, 1), /complete embedded material/)
  const corrupt = Buffer.from(png); corrupt[corrupt.length - 20] ^= 255
  await write(geometry, corrupt)
  await assert.rejects(validateDesignGlb(file, 1), /complete embedded/)
})
