import { z } from 'zod'
import { defaultLandmarks, boneLinks } from '../shared/rig'
import { expandGraph } from '../shared/plans'
import { defaultHandPose } from '../shared/hand-pose'
import { handLinks, handPointNames, handPrefix, handSides } from '../shared/hand-rig'
import { Vector3 } from 'three'
import { poseAt, sameHandPose } from '../shared/hand-animation'

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
export const skinningSchema = z.enum(['automatic', 'fallback']).default('automatic')
export const rotationSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-180).max(180), z.number().min(-180).max(180)])
const wristPoseSchema = z.object({
  version: z.literal(1),
  detail: z.literal('wrist'),
  left: rotationSchema,
  right: rotationSchema
}).strict()
const fingerPoseSchema = z.object({
  thumb: z.number().finite().min(0).max(1), index: z.number().finite().min(0).max(1),
  fingers: z.number().finite().min(0).max(1), opposition: z.number().finite().min(0).max(1)
}).strict()
const fingerPairSchema = z.object({ left: fingerPoseSchema, right: fingerPoseSchema }).strict()
const keyframesSchema = z.array(z.object({ time: z.number().finite().min(0).max(1), fingers: fingerPairSchema }).strict()).min(2).max(16)
  .refine(keys => keys.length >= 2 && keys[0].time === 0 && keys.at(-1)!.time === 1 && keys.every((key, i) => i === 0 || key.time > keys[i - 1].time),
    'Hand keys must be ordered, unique, and include times zero and one.')
export const fingerTrackSchema = z.object({ fingers: fingerPairSchema, keyframes: keyframesSchema.optional() }).strict()
export const handPoseSchema = z.discriminatedUnion('version', [wristPoseSchema, z.object({
  version: z.literal(2), detail: z.literal('basic'), left: rotationSchema, right: rotationSchema,
  fingers: fingerPairSchema, keyframes: keyframesSchema.optional()
}).strict()]).default(defaultHandPose)
export const handTimelineSchema = z.array(z.object({
  start: z.number().int().min(0).max(1799), end: z.number().int().min(1).max(1799), pose: handPoseSchema.unwrap()
}).strict()).min(1).max(64).refine(spans => spans.length > 0 && spans[0].start === 0 &&
  spans.every(span => handPoseSchema.safeParse(span.pose).success) && spans.every((span, i) =>
  span.end > span.start && (i === 0 || span.start === spans[i - 1].end && sameHandPose(poseAt(spans[i - 1].pose, 1), poseAt(span.pose, 0)))),
  'Hand timeline spans must cover the path without gaps or hand-pose jumps.')
const radius = z.number().finite().min(0.003).max(0.08)
const handRigSchema = z.discriminatedUnion('detail', [
  z.object({ detail: z.literal('wrist') }).strict(),
  z.object({ detail: z.literal('basic'), thumbRadius: radius, indexRadius: radius, fingersRadius: radius }).strict()
])
export const setupSchema = z.object({
  rotation: rotationSchema,
  landmarks: z.record(z.string(), point),
  hands: z.object({ left: handRigSchema, right: handRigSchema }).strict().optional()
}).strict().superRefine((setup, ctx) => {
  for (const name of Object.keys(defaultLandmarks())) {
    if (!setup.landmarks[name]) ctx.addIssue({ code: 'custom', message: `Missing ${name} landmark` })
  }
  for (const [a, b] of boneLinks) {
    const p = setup.landmarks[a], q = setup.landmarks[b]
    if (p && q && Math.hypot(...p.map((v, i) => v - q[i])) < 0.015)
      ctx.addIssue({ code: 'custom', message: `${a} and ${b} must be at least 1.5cm apart.` })
  }
  for (const side of handSides) if (setup.hands?.[side].detail === 'basic') {
    for (const name of handPointNames(side)) if (!setup.landmarks[name])
      ctx.addIssue({ code: 'custom', message: `Missing ${name}. Add and fit the hand template before rigging.` })
    const wrist = setup.landmarks[`${handPrefix(side)}Hand`], end = setup.landmarks[`${handPrefix(side)}HandEnd`]
    const marker = setup.landmarks[`${handPrefix(side)}PalmNormal`]
    if (wrist && end && marker) {
      const direction = new Vector3(...end).sub(new Vector3(...wrist)).normalize()
      const normal = new Vector3(...marker).sub(new Vector3(...wrist))
      if (normal.length() < 0.005 || Math.abs(normal.normalize().dot(direction)) > 0.9)
        ctx.addIssue({ code: 'custom', message: `${handPrefix(side)}PalmNormal must point out of the back of the hand, not along its fingers.` })
      for (const [a, b] of handLinks(setup).filter(([a]) => a.startsWith(handPrefix(side)) && a !== `${handPrefix(side)}Hand`)) {
        const head = setup.landmarks[a], tail = setup.landmarks[b]
        if (head && tail && Math.abs(new Vector3(...tail).sub(new Vector3(...head)).normalize().dot(normal)) > 0.95)
          ctx.addIssue({ code: 'custom', message: `${a}: the palm normal must point across the finger, not along it.` })
      }
      const index = setup.landmarks[`${handPrefix(side)}Index1`], fingers = setup.landmarks[`${handPrefix(side)}Fingers1`]
      if (index && fingers && new Vector3(...index).add(new Vector3(...fingers)).multiplyScalar(0.5).distanceTo(new Vector3(...wrist)) < 0.003)
        ctx.addIssue({ code: 'custom', message: `${handPrefix(side)} finger bases must be beyond the wrist.` })
    }
  }
  for (const [a, b] of handLinks(setup)) {
    const p = setup.landmarks[a], q = setup.landmarks[b]
    if (p && q && Math.hypot(...p.map((v, i) => v - q[i])) < 0.003)
      ctx.addIssue({ code: 'custom', message: `${a} and ${b} must be at least 3mm apart.` })
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
  legacySegments: z.boolean().optional(), fingerPose: fingerTrackSchema.optional()
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
