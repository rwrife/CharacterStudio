import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { generateMotion, cancelMotion } from '../src/main/comfy'

test('Comfy API submits exact graph, polls matching history and cancels only its own ID', async () => {
  let id = '', cancelled = '', submitted: Record<string, unknown> = {}
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/prompt') {
      submitted = JSON.parse(raw); id = String(submitted.prompt_id)
      res.end(JSON.stringify({ prompt_id: id }))
    } else if (req.url === `/history/${id}`) {
      res.end(JSON.stringify({ [id]: { status: { completed: true, status_str: 'success', messages: [] }, outputs: { '6': { motion_json: [JSON.stringify({ fps: 30, num_frames: 60, num_joints: 77 })] } } } }))
    } else if (req.url === `/api/jobs/${id}/cancel`) {
      cancelled = id; res.end('{"cancelled":true}')
    } else { res.statusCode = 404; res.end('{}') }
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const result = await generateMotion({
      base, prefix: 'test', signal: new AbortController().signal,
      request: { characterId: 'x', prompt: 'Walk.', seconds: 2, seed: 42, steps: 25, inPlace: false },
      progress: () => {}, submitted: () => {}
    })
    assert.equal(result.fps, 30)
    assert.equal(result.frames, 60)
    assert.equal(result.promptId, id)
    assert.ok(submitted.prompt)
    await cancelMotion(base, id)
    assert.equal(cancelled, id)
  } finally { server.closeAllConnections(); server.close() }
})

test('completed metadata must match the requested segment frame count', async () => {
  let id = '', frames = 29
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/prompt') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      id = JSON.parse(raw).prompt_id
      res.end(JSON.stringify({ prompt_id: id }))
    } else res.end(JSON.stringify({ [id]: { status: { completed: true, status_str: 'success', messages: [] },
      outputs: { '6': { motion_json: [JSON.stringify({ fps: 30, num_frames: frames, num_joints: 77 })] } } } }))
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const generate = () => generateMotion({
    base: `http://127.0.0.1:${address.port}`, prefix: 'frame-test', signal: new AbortController().signal,
    request: { characterId: 'x', prompt: 'Crouch. Stand.', seconds: 1, seed: 42, steps: 25, inPlace: false },
    progress: () => {}, submitted: () => {}
  })
  try {
    await assert.rejects(generate(), /29 frames; expected 60/)
    frames = 60
    assert.equal((await generate()).frames, 60)
  } finally { server.closeAllConnections(); server.close() }
})

test('execution errors are surfaced rather than treated as output', async () => {
  let id = ''
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/prompt') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      id = JSON.parse(raw).prompt_id
      res.end(JSON.stringify({ prompt_id: id }))
    } else res.end(JSON.stringify({ [id]: { status: { completed: false, status_str: 'error', messages: [['execution_error', { node_type: 'Kimodo_TextEncode', exception_message: '403 gated model' }]] }, outputs: {} } }))
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await assert.rejects(generateMotion({
      base: `http://127.0.0.1:${address.port}`, prefix: 'test', signal: new AbortController().signal,
      request: { characterId: 'x', prompt: 'Walk.', seconds: 2, seed: 42, steps: 25, inPlace: false },
      progress: () => {}, submitted: () => {}
    }), /403 gated model/)
  } finally { server.closeAllConnections(); server.close() }
})
