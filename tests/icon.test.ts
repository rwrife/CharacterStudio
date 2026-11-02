import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('packaged and renderer icons use the same square PNG', async () => {
  const [packaged, renderer] = await Promise.all([
    readFile('build/icon.png'),
    readFile('src/renderer/public/icon.png')
  ])
  assert.deepEqual(packaged, renderer)
  assert.equal(packaged.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(packaged.readUInt32BE(16), 1024)
  assert.equal(packaged.readUInt32BE(20), 1024)
})

test('Windows icon includes small, high-DPI and taskbar sizes', async () => {
  const icon = await readFile('build/icon.ico')
  assert.equal(icon.readUInt16LE(0), 0)
  assert.equal(icon.readUInt16LE(2), 1)
  const sizes: number[] = []
  for (let i = 0; i < icon.readUInt16LE(4); i++) {
    const entry = 6 + i * 16
    const width = icon[entry] || 256
    assert.equal(icon[entry + 1] || 256, width)
    const length = icon.readUInt32LE(entry + 8)
    const offset = icon.readUInt32LE(entry + 12)
    assert.ok(length > 0 && offset + length <= icon.length)
    sizes.push(width)
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256])
})
