import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { expandGraph, createBatchItems } from '../src/shared/plans'
import { defaultLandmarks } from '../src/shared/rig'
import { planSchema, batchSchema } from '../src/main/validation'
import { Studio } from '../src/main/studio'
import type { MotionNode, MotionPlan, Character, Job } from '../src/shared/types'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const node = (label: string, patch: Partial<MotionNode> = {}): MotionNode => ({
  id: randomUUID(), label, prompt: 'A person moves.', seconds: 3, seed: 42, steps: 100, inPlace: false,
  kind: 'action', loop: false, stance: '', position: { x: 0, y: 0 }, ...patch
})
const character = (name: string): Character => ({
  id: randomUUID(), name, importedAt: new Date().toISOString(), previewUrl: '', meshes: 1, vertices: 100,
  warnings: [], setup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() }, rigged: true
})
function plan(nodes: MotionNode[], connections: [MotionNode, MotionNode][] = [], entries = [nodes[0].id]): MotionPlan {
  return {
    id: randomUUID(), name: 'Graph', rigSetup: { rotation: [0, 0, 0], landmarks: defaultLandmarks() }, graphVersion: 2,
    nodes, entryNodeIds: entries, edges: connections.map(([a, b]) => ({ id: randomUUID(), source: a.id, target: b.id, seconds: 0.5 }))
  }
}
function fighting() {
  const idle = node('Idle', { kind: 'state', prompt: 'Standing idle. Slight sway.' })
  const crouch = node('Crouch', { kind: 'state', prompt: 'Crouched down low with subtle motion.' })
  const punch = node('Punch', { prompt: 'Throw a right hook punch.' })
  return { idle, crouch, punch, graph: plan([idle, crouch, punch], [[idle, punch], [idle, crouch], [crouch, punch]]) }
}
test('one shared punch expands into distinct standing and crouched pose contexts', () => {
  const { graph, punch } = fighting()
  const contexts = expandGraph(graph)
  assert.equal(graph.nodes.length, 3)
  assert.equal(contexts.length, 4)
  const punches = contexts.filter(c => c.path.at(-1) === punch.id)
  assert.equal(punches.length, 2)
  assert.notEqual(punches[0].key, punches[1].key)
  assert.match(punches[0].effectivePrompt, /Standing idle/)
  assert.match(punches[1].effectivePrompt, /Crouched down low/)
  assert.ok(punches.every(c => c.effectivePrompt.includes('right hook')))
  assert.ok(punches.every(c => !c.effectivePrompt.includes('.')), 'Context must not add ComfyUI motion segments.')
  assert.equal(punch.prompt, 'Throw a right hook punch.')
})
test('outgoing stance overrides propagate while default actions inherit', () => {
  const { graph, punch } = fighting()
  punch.stance = 'Standing upright after rising'
  const follow = node('Block')
  graph.nodes.push(follow)
  graph.edges.push({ id: randomUUID(), source: punch.id, target: follow.id, seconds: 0.5 })
  const contexts = expandGraph(graph).filter(c => c.path.at(-1) === follow.id)
  assert.equal(contexts.length, 2)
  assert.ok(contexts.every(c => c.inheritedStance === punch.stance))
  const crouchedPunch = expandGraph(graph).find(c => c.path.at(-1) === punch.id && c.inheritedStance.includes('Crouched'))!
  assert.match(crouchedPunch.effectivePrompt, /posture context "Crouched down low/)
  assert.match(crouchedPunch.effectivePrompt, /resulting posture: Standing upright/)
})
test('cycles emit one returning variant and stop; unreachable nodes never disappear silently', () => {
  const a = node('Idle'), b = node('Punch')
  const graph = plan([a, b], [[a, b], [b, a]])
  const contexts = expandGraph(graph)
  assert.deepEqual(contexts.map(c => c.pathLabel), ['Idle', 'Idle → Punch', 'Idle → Punch → Idle'])
  assert.equal(contexts[2].cycleEnd, true)
  assert.throws(() => expandGraph({ ...graph, nodes: [...graph.nodes, node('Lost')] }), /Lost/)
  assert.equal(planSchema.safeParse({ ...graph, entryNodeIds: [] }).success, false)
})
test('graph validation bounds paths, expansion, duplicate edges and root modes', () => {
  const { graph, idle, crouch } = fighting()
  assert.equal(planSchema.safeParse(graph).success, true)
  assert.equal(planSchema.safeParse({ ...graph, edges: [...graph.edges, { ...graph.edges[0], id: randomUUID() }] }).success, false)
  assert.equal(planSchema.safeParse({ ...graph, nodes: graph.nodes.map(n => n.id === idle.id ? { ...n, inPlace: true } : n) }).success, false)
  assert.equal(planSchema.safeParse({ ...graph, nodes: graph.nodes.map(n => ({ ...n, seconds: 30 })) }).success, false)
  assert.equal(planSchema.safeParse({ ...graph, edges: [...graph.edges, { id: randomUUID(), source: idle.id, target: randomUUID(), seconds: 1 }] }).success, false)
  assert.equal(planSchema.safeParse({ ...graph, nodes: graph.nodes.map(n => n.id === crouch.id ? { ...n, loop: true } : n) }).success, true)
  const many = Array.from({ length: 10 }, (_, i) => node(`Node ${i}`, { seconds: 0.5 }))
  const dense = plan(many, many.flatMap((a, i) => many.slice(i + 1).map(b => [a, b] as [MotionNode, MotionNode])))
  assert.throws(() => expandGraph(dense), /64 path-specific/)
})
test('legacy configurations migrate without changing prompts, duration or direct-pose relationships', () => {
  const id = randomUUID(), parentId = randomUUID(), childId = randomUUID()
  const motion = { label: 'Old motion', prompt: 'Crouch. Stand.', seconds: 3, seed: 42, steps: 100, inPlace: true }
  const migrated = planSchema.parse({ id, name: 'Legacy', rigSetup: character('Test').setup, nodes: [
    { ...motion, id: parentId }, { ...motion, id: childId, parentId }
  ] })
  assert.equal(migrated.graphVersion, 2)
  assert.equal(migrated.edges[0].seconds, 0)
  assert.deepEqual(migrated.entryNodeIds, [parentId])
  assert.ok(migrated.nodes.every(n => n.legacySegments))
  assert.deepEqual(expandGraph(migrated).map(c => c.effectivePrompt), [motion.prompt, motion.prompt])
})
test('batch items use parent instance IDs and path-scoped reproducible seeds', () => {
  const { graph, punch } = fighting()
  const characters = ['First', 'Second'].map(character)
  const request = { planId: graph.id, characterIds: characters.map(c => c.id), seedStride: 100, autoRig: false }
  const items = createBatchItems(graph, request, characters, randomUUID)
  assert.deepEqual(items.map(i => i.seed), [42, 42, 42, 42, 142, 142, 142, 142])
  const punches = items.filter(i => i.nodeId === punch.id)
  assert.notEqual(punches[0].parentItemId, punches[1].parentItemId)
  assert.equal(punches[0].context!.key, punches[2].context!.key)
  assert.notEqual(punches[0].parentItemId, punches[2].parentItemId)
  assert.equal(batchSchema.safeParse({ ...request, characterIds: [characters[0].id, characters[0].id] }).success, false)
})
test('saved graph round-trips with layouts and interrupted jobs remain incomplete', t => {
  const root = mkdtempSync(join(tmpdir(), 'kimodo-plans-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const studio = new Studio(root, resolve('.')), { graph } = fighting()
  graph.nodes[1].position = { x: 325, y: 180 }
  studio.savePlan(graph)
  assert.deepEqual(new Studio(root, resolve('.')).plan(graph.id), graph)
  const statePath = join(root, 'studio.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.batches.push({ id: randomUUID(), status: 'running', items: [{ status: 'running' }, { status: 'pending' }, { status: 'complete' }] })
  writeFileSync(statePath, JSON.stringify(state))
  const restarted = new Studio(root, resolve('.')).snapshot()
  assert.equal(restarted.batches[0].status, 'failed')
  assert.deepEqual(restarted.batches[0].items.map(i => i.status), ['blocked', 'blocked', 'complete'])
})
test('cancellation during preflight starts no graph jobs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kimodo-cancel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initial = new Studio(root, resolve('.')), target = character('Target'), { graph } = fighting()
  writeFileSync(join(root, 'studio.json'), JSON.stringify({ ...initial.snapshot(), characters: [target] }))
  const studio = new Studio(root, resolve('.'))
  studio.savePlan(graph)
  studio.saveSettings({ ...studio.snapshot().settings, textEncoder: 'lfm' })
  studio.check = async signal => new Promise(resolve => signal!.addEventListener('abort', () => resolve([]), { once: true }))
  const pending = assert.rejects(studio.runBatch({ planId: graph.id, characterIds: [target.id], seedStride: 0, autoRig: false }), /Batch cancelled/)
  await studio.cancel(); await pending
  assert.equal(studio.snapshot().batches[0].status, 'cancelled')
  assert.ok(studio.snapshot().batches[0].items.every(i => i.status === 'cancelled'))
  assert.equal(studio.snapshot().jobs.length, 0)
  assert.equal(studio.snapshot().batches[0].textEncoder, 'lfm')
  studio.saveSettings({ ...studio.snapshot().settings, textEncoder: 'llm2vec' })
  await assert.rejects(studio.rerunBatch(studio.snapshot().batches[0].id), /original LFM bridge/)
  await studio.dispose()
})
test('a failed context blocks only its descendants; replay uses the immutable graph', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kimodo-context-failure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const initial = new Studio(root, resolve('.')), target = character('Target'), { graph, punch } = fighting()
  const follow = node('Recover')
  graph.nodes.push(follow); graph.edges.push({ id: randomUUID(), source: punch.id, target: follow.id, seconds: 0.5 })
  writeFileSync(join(root, 'studio.json'), JSON.stringify({ ...initial.snapshot(), characters: [target] }))
  const studio = new Studio(root, resolve('.'))
  studio.check = async () => []
  studio.generate = async (request, batch) => {
    assert.ok(batch)
    if (batch.context.path.length === 2 && batch.nodeId === punch.id) throw new Error('Standing punch fixture failure')
    return { id: randomUUID(), characterId: request.characterId, characterName: target.name, kind: 'generate', stage: 'complete', message: 'Test fixture only', progress: 100, createdAt: new Date().toISOString() } satisfies Job
  }
  studio.savePlan(graph)
  await studio.runBatch({ planId: graph.id, characterIds: [target.id], seedStride: 0, autoRig: false })
  const batch = studio.snapshot().batches[0]
  assert.deepEqual(batch.items.map(i => i.status), ['complete', 'failed', 'blocked', 'complete', 'complete', 'complete'])
  studio.savePlan({ ...graph, name: 'Changed', nodes: graph.nodes.map(n => ({ ...n, seed: 987 })) })
  await studio.rerunBatch(batch.id)
  assert.deepEqual(studio.snapshot().batches[0].plan, batch.plan)
  await studio.dispose()
})
