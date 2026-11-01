import { z } from 'zod'
import { defaultLandmarks, boneLinks } from '../shared/rig'
import { expandGraph } from '../shared/plans'

export function localUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a local ComfyUI URL such as http://127.0.0.1:8189. Remote character uploads are disabled.')
  }
  return url.origin
}

export const settingsSchema = z.object({
  comfyUrl: z.string().transform(localUrl),
  comfyRoot: z.string().min(1).max(1024),
  comfyOutput: z.string().min(1).max(1024),
  blenderPath: z.string().min(1).max(1024),
  textEncoder: z.enum(['llm2vec', 'lfm']).default('llm2vec')
}).strict()

const point = z.tuple([z.number().finite().min(-4).max(4), z.number().finite().min(-4).max(4), z.number().finite().min(-4).max(4)])
export const setupSchema = z.object({
  rotation: z.tuple([z.number().min(-180).max(180), z.number().min(-180).max(180), z.number().min(-180).max(180)]),
  landmarks: z.record(z.string(), point)
}).strict().superRefine((setup, ctx) => {
  for (const name of Object.keys(defaultLandmarks())) {
    if (!setup.landmarks[name]) ctx.addIssue({ code: 'custom', message: `Missing ${name} landmark` })
  }
  for (const [a, b] of boneLinks) {
    const p = setup.landmarks[a], q = setup.landmarks[b]
    if (p && q && Math.hypot(...p.map((v, i) => v - q[i])) < 0.015)
      ctx.addIssue({ code: 'custom', message: `${a} and ${b} must be at least 1.5cm apart.` })
  }
})

export const generateSchema = z.object({
  characterId: z.uuid(),
  prompt: z.string().trim().min(3).max(1000),
  seconds: z.number().finite().min(0.5).max(30),
  seed: z.number().int().min(0).max(4294967295),
  steps: z.number().int().min(10).max(500),
  inPlace: z.boolean(),
  parentJobId: z.uuid().optional()
}).strict().superRefine((r, ctx) => {
  if (r.prompt.split('.').filter(p => p.trim()).length * r.seconds > 60)
    ctx.addIssue({ code: 'custom', message: 'Combined motion segments must be 60 seconds or less.' })
})

const motionFields = {
  id: z.uuid(), label: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(3).max(1000),
  seconds: z.number().finite().min(0.5).max(30),
  seed: z.number().int().min(0).max(4294967295),
  steps: z.number().int().min(10).max(500), inPlace: z.boolean()
}
const planFields = {
  id: z.uuid(), name: z.string().trim().min(1).max(100),
  rigSetup: setupSchema
}
const motionNodeSchema = z.object({
  ...motionFields, kind: z.enum(['state', 'action']), loop: z.boolean(), stance: z.string().trim().max(500),
  position: z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict(),
  legacySegments: z.boolean().optional()
}).strict()
const graphSchema = z.object({
  ...planFields, graphVersion: z.literal(2), nodes: z.array(motionNodeSchema).min(1).max(32),
  edges: z.array(z.object({ id: z.string().min(1).max(100), source: z.uuid(), target: z.uuid(), seconds: z.number().finite().min(0).max(5) }).strict()).max(64),
  entryNodeIds: z.array(z.uuid()).min(1).max(32)
}).strict()
const legacyPlanSchema = z.object({
  ...planFields, nodes: z.array(z.object({ ...motionFields, parentId: z.uuid().optional() }).strict()).min(1).max(32)
}).strict().transform(plan => ({
  ...plan, graphVersion: 2 as const,
  entryNodeIds: plan.nodes.filter(n => !n.parentId).map(n => n.id),
  edges: plan.nodes.flatMap(n => n.parentId ? [{ id: `legacy-${n.id}`, source: n.parentId, target: n.id, seconds: 0 }] : []),
  nodes: plan.nodes.map(({ parentId, ...n }, i) => ({
    ...n, kind: 'action' as const, loop: false, stance: '', legacySegments: true,
    position: { x: parentId ? 320 : 0, y: i * 150 }
  }))
}))
export const planSchema = z.union([graphSchema, legacyPlanSchema]).superRefine((plan, ctx) => {
  try {
    for (const edge of plan.edges)
      if (edge.seconds > 0 && edge.seconds < 0.5) throw new Error('Transitions must be disabled (0) or at least 0.5 seconds.')
    for (const node of plan.nodes) {
      if (node.loop && (node.kind !== 'state' || node.legacySegments))
        throw new Error('Loop closure is available for single-segment state nodes only.')
    }
    expandGraph(plan)
  } catch (error) { ctx.addIssue({ code: 'custom', message: errorText(error) }) }
})
export const batchSchema = z.object({
  planId: z.uuid(), characterIds: z.array(z.uuid()).min(1).max(32),
  seedStride: z.number().int().min(0).max(1000000), autoRig: z.boolean()
}).strict().refine(batch => new Set(batch.characterIds).size === batch.characterIds.length, 'Select each character only once.')

export function errorText(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(i => i.message).join(' ')
  return error instanceof Error ? error.message : String(error)
}
