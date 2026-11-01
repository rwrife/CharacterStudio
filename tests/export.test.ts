import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateCharacterGlb } from '../src/main/export-validation'

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
