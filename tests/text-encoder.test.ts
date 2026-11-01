import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recommendTextEncoder } from '../src/shared/text-encoder'

test('encoder memory recommendations use currently free memory and the exact 24 GiB boundary', () => {
  const gpu = { name: 'Test GPU', totalGB: 48, freeGB: 24 }
  assert.equal(recommendTextEncoder(gpu).encoder, 'llm2vec')
  assert.equal(recommendTextEncoder({ ...gpu, freeGB: 23.99 }).encoder, 'lfm')
  assert.equal(recommendTextEncoder({ ...gpu, freeGB: 8 }).encoder, 'lfm')
  assert.match(recommendTextEncoder({ ...gpu, freeGB: 3 }).detail, /tight even for LFM/)
})

test('missing or invalid memory does not invent a recommendation', () => {
  for (const gpu of [undefined, { name: 'Test', totalGB: 0, freeGB: 0 }, { name: 'Test', totalGB: 16, freeGB: 17 },
    { name: 'Test', totalGB: 16, freeGB: -1 }, { name: 'Test', totalGB: NaN, freeGB: 2 }])
    assert.equal(recommendTextEncoder(gpu).encoder, undefined)
})
