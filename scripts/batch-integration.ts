/** Controlled analytic fixture server: validates queue/export mechanics, NOT AI generation. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { mkdir, readFile, copyFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { Studio } from '../src/main/studio'
import { planSchema } from '../src/main/validation'

const root = resolve('artifacts', 'batch-integration-state')
const output = join(root, 'fixture-output')
await mkdir(output, { recursive: true })
const studio = new Studio(root, resolve('.'))
const history: Record<string, unknown> = {}
let submissions = 0, constraints = 0
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    if (req.url === '/prompt') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const data = JSON.parse(raw)
      const prefix = data.prompt['4'].inputs.filename_prefix
      const constraint = data.prompt['3'].inputs.constraints_json
      if (constraint) {
        const values = JSON.parse(await readFile(constraint, 'utf8'))
        assert.deepEqual(values[0].frame_indices, [0]); assert.equal(values[0].type, 'fullbody'); constraints++
      }
      for (const ext of ['npz', 'bvh']) await copyFile(resolve('artifacts', 'bruiser-analytic-test', `test-motion.${ext}`), join(output, `${prefix}_fixture.${ext}`))
      history[data.prompt_id] = { status: { completed: true, status_str: 'success', messages: [] }, outputs: { '6': { motion_json: [JSON.stringify({ fps: 30, num_frames: 60, num_joints: 77 })] } } }
      submissions++
      res.end(JSON.stringify({ prompt_id: data.prompt_id }))
    } else if (req.url?.startsWith('/history/')) {
      const id = req.url.slice('/history/'.length)
      res.end(JSON.stringify(history[id] ? { [id]: history[id] } : {}))
    } else if (req.url?.endsWith('/cancel')) res.end('{"cancelled":false}')
    else { res.statusCode = 404; res.end('{}') }
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
})
server.on('upgrade', (_req, socket) => socket.destroy())
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const address = server.address()
assert.ok(address && typeof address !== 'string')
studio.saveSettings({ ...studio.snapshot().settings, comfyUrl: `http://127.0.0.1:${address.port}`, comfyOutput: output })
// The real readiness check is tested separately; this harness uses no model or external service.
studio.check = async () => []
try {
  while (studio.snapshot().characters.length < 2) {
    const character = await studio.importCharacter(resolve('artifacts', 'Bruiser_base.fbx'))
    studio.saveSetup(character.id, JSON.parse(await readFile(resolve('tests', 'fixtures', 'bruiser-setup.json'), 'utf8')))
    await studio.rig(character.id)
  }
  const rootId = randomUUID()
  const plan = planSchema.parse({
    id: randomUUID(), name: 'ANALYTIC HARNESS ONLY - NOT COMFYUI GENERATION',
    rigSetup: studio.snapshot().characters[0].setup,
    nodes: [
      { id: rootId, label: 'Analytic root', prompt: 'Analytic test only.', seconds: 2, seed: 42, steps: 25, inPlace: false },
      { id: randomUUID(), label: 'Analytic branch A', parentId: rootId, prompt: 'Analytic branch test.', seconds: 2, seed: 43, steps: 25, inPlace: false },
      { id: randomUUID(), label: 'Analytic branch B', parentId: rootId, prompt: 'Analytic branch test.', seconds: 2, seed: 44, steps: 25, inPlace: false }
    ]
  })
  studio.savePlan(plan)
  await studio.runBatch({ planId: plan.id, characterIds: studio.snapshot().characters.slice(0, 2).map(c => c.id), seedStride: 0, autoRig: false })
  const result = studio.snapshot().batches[0]
  assert.equal(result.status, 'complete')
  assert.equal(result.items.length, 6)
  assert.ok(result.items.every(i => i.status === 'complete'))
  assert.equal(submissions, 3, 'Identical motion must generate once per node, then reuse exact data.')
  assert.equal(constraints, 2, 'Both branches must have real parent endpoint constraints.')
  assert.equal(studio.snapshot().jobs.filter(j => j.batchId === result.id && j.reusedMotionFrom).length, 3)
  const exported = await studio.exportBatch(result.id, resolve('artifacts'))
  assert.equal((await readdir(exported)).filter(f => f !== 'batch.json').length, 6)
  studio.savePlan({ ...plan, name: 'Edited later', nodes: plan.nodes.map(n => ({ ...n, seed: 987, prompt: 'Changed after batch.' })) })
  studio.check = async () => [{ name: 'Fixture stop', status: 'blocked', detail: 'Intentional replay preflight stop in test.' }]
  await assert.rejects(studio.rerunBatch(result.id), /Intentional replay/)
  const replay = studio.snapshot().batches[0]
  assert.deepEqual(replay.plan, result.plan, 'Replay must use the original immutable configuration.')
  assert.deepEqual(replay.items.map(i => i.seed), result.items.map(i => i.seed))
  console.log('ANALYTIC HARNESS PASS: 2 real skinned Bruiser imports x 3 motion nodes; 6 animated exports; 2 checked forks; 3 exact source reuses; batch folder export and immutable replay.')
} finally { await studio.dispose(); server.closeAllConnections(); server.close() }
