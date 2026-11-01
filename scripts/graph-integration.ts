/** Analytic graph harness; validates orchestration and real skinned exports, not learned motion quality. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { Studio } from '../src/main/studio'
import { runProcess } from '../src/main/process'
import { validateCharacterGlb } from '../src/main/export-validation'
import type { MotionNode, MotionPlan } from '../src/shared/types'

const root = resolve('artifacts', 'graph-integration-state')
const output = join(root, 'fixture-output')
await mkdir(output, { recursive: true })
const studio = new Studio(root, resolve('.'))
const settings = studio.snapshot().settings
const kimodo = join(settings.comfyRoot, 'custom_nodes', 'ComfyUI-Kimodo', 'kimodo')
const python = join(settings.comfyRoot, 'venv', 'Scripts', 'python.exe')
const history: Record<string, unknown> = {}
const submissions: { stage: string; prompt: string; constraint?: string }[] = []
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    if (req.url === '/prompt') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const data = JSON.parse(raw), inputs = data.prompt['3'].inputs
      const prefix = data.prompt['4'].inputs.filename_prefix
      const stage = prefix.split('_').at(-1)
      const request = join(output, `${prefix}.json`)
      const prompt = data.prompt['2'].inputs.prompt
      await writeFile(request, JSON.stringify({
        kimodo, stage, prompt, seconds: inputs.duration, constraints: inputs.constraints_json,
        output: join(output, `${prefix}_fixture.npz`)
      }))
      await runProcess(python, [resolve('tests', 'make_graph_motion.py'), request])
      submissions.push({ stage, prompt, constraint: inputs.constraints_json })
      history[data.prompt_id] = { status: { completed: true, status_str: 'success', messages: [] }, outputs: { '6': { motion_json: [JSON.stringify({ fps: 30, num_frames: inputs.duration * 30, num_joints: 77 })] } } }
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
studio.saveSettings({ ...settings, comfyUrl: `http://127.0.0.1:${address.port}`, comfyOutput: output })
studio.check = async () => []
let previous = ''
studio.onUpdate = snapshot => {
  const text = snapshot.batches[0]?.items.map(i => i.status).join(',')
  if (text && text !== previous) { console.log('Graph fixture queue:', text); previous = text }
}
try {
  while (studio.snapshot().characters.length < 2) {
    const character = await studio.importCharacter(resolve('artifacts', 'Bruiser_base.fbx'))
    studio.saveSetup(character.id, JSON.parse(await readFile(resolve('tests', 'fixtures', 'bruiser-setup.json'), 'utf8')))
    await studio.rig(character.id)
  }
  const makeNode = (label: string, kind: MotionNode['kind'], prompt: string, y: number): MotionNode => ({
    id: randomUUID(), label, kind, prompt, seconds: 1, seed: 42, steps: 25, inPlace: false,
    stance: '', loop: kind === 'state', position: { x: y * 2, y }
  })
  const idle = makeNode('Analytic standing idle', 'state', 'Standing upright with subtle motion.', 0)
  const crouch = makeNode('Analytic crouch', 'state', 'Crouched down low with subtle motion.', 180)
  const punch = makeNode('Shared analytic punch', 'action', 'Throw a right hook punch.', 360)
  const plan: MotionPlan = {
    id: randomUUID(), graphVersion: 2, name: 'ANALYTIC GRAPH HARNESS - NOT AI GENERATED',
    rigSetup: studio.snapshot().characters[0].setup, nodes: [idle, crouch, punch], entryNodeIds: [idle.id],
    edges: [[idle.id, punch.id], [idle.id, crouch.id], [crouch.id, punch.id]].map(([source, target]) => ({ id: randomUUID(), source, target, seconds: 0.5 }))
  }
  studio.savePlan(plan)
  await studio.runBatch({ planId: plan.id, characterIds: studio.snapshot().characters.slice(0, 2).map(c => c.id), seedStride: 0, autoRig: false })
  const snapshot = studio.snapshot(), result = snapshot.batches[0]
  assert.equal(result.status, 'complete', JSON.stringify(result.items.map(i => ({ path: i.context?.pathLabel, status: i.status, error: i.message })), null, 2))
  assert.equal(result.items.length, 8)
  assert.equal(submissions.length, 9, '4 context-specific nodes + 2 loop passes + 3 transitions; second character reuses each exact context.')
  assert.equal(submissions.filter(s => s.stage === 'transition').length, 3)
  const jobs = snapshot.jobs.filter(j => j.batchId === result.id)
  assert.equal(jobs.filter(j => j.reusedMotionFrom).length, 4)
  const punches = jobs.filter(j => j.planNodeId === punch.id && !j.reusedMotionFrom)
  assert.equal(punches.length, 2)
  const heights: number[] = []
  for (const job of punches) {
    const path = join(root, 'jobs', job.id)
    const constraint = JSON.parse(await readFile(join(path, 'branch-constraints.json'), 'utf8'))
    heights.push(constraint[0].root_positions[0][1])
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
    assert.ok(manifest.samplingRequest.prompt.includes(job.graphContext!.inheritedStance.replace(/\./g, ',').replace(/,\s*$/, '')))
    assert.equal(job.graphContext!.path.at(-1), punch.id)
  }
  assert.ok(Math.max(...heights) - Math.min(...heights) > 0.3, 'Shared punch must receive genuinely different standing/crouched entry poses.')
  for (const job of jobs) {
    for (const file of job.outputFiles!.filter(f => f.endsWith('.glb'))) await validateCharacterGlb(studio.output(job.id, file), true)
    if (job.reusedMotionFrom) {
      for (const file of ['motion.npz', ...(job.transitionPreviewUrl ? ['transition.npz'] : [])]) {
        const digest = async (id: string) => createHash('sha256').update(await readFile(join(root, 'jobs', id, file))).digest('hex')
        assert.equal(await digest(job.id), await digest(job.reusedMotionFrom))
      }
    }
    if (job.transitionPreviewUrl) {
      for (const file of ['approach.seam.json', 'sequence.seam.json']) {
        const seam = JSON.parse(await readFile(join(root, 'jobs', job.id, file), 'utf8'))
        assert.ok(seam.rootErrorMeters <= 0.02 && seam.maximumBodyRotationErrorDegrees <= 5)
      }
      const node = JSON.parse(await readFile(join(root, 'jobs', job.id, 'clip-motion.json'), 'utf8'))
      const transition = JSON.parse(await readFile(join(root, 'jobs', job.id, 'transition-motion.json'), 'utf8'))
      assert.deepEqual(node.root_origin, transition.root_origin, 'Separate character exports must share the path origin.')
    }
  }
  const folder = await studio.exportBatch(result.id, resolve('artifacts'))
  assert.equal((await readdir(folder)).length, 9)
  await writeFile(resolve('artifacts', 'graph-validation.json'), JSON.stringify({ fixture: 'ANALYTIC, NOT AI GENERATION', batch: result.id, variants: 8, submissions: 9, standingAndCrouchedRootHeights: heights, exportFolder: folder }, null, 2))
  console.log('ANALYTIC GRAPH PASS: shared punch receives different actual poses; 8 real skinned variants; loop closure; two-endpoint transitions; path-specific reuse; separate node/transition/path character exports.')
} finally { await studio.dispose(); server.closeAllConnections(); server.close() }
