import { z } from 'zod'

export const aiStages = {
  naming: 'Character naming',
  scene: 'Scene / concept',
  tpose: 'T-pose editing',
  cutout: 'Background removal',
  mesh: '3D mesh generation',
  texture: 'PBR texturing',
  rig: 'Remote rigging',
  motion: 'Motion + text encoder',
  capture: 'Video pose capture',
  segmentation: 'Part segmentation (future)',
  landmarks: 'Landmark detection (future)',
  cloth: 'Cloth analysis (future)'
} as const
export type AiStage = keyof typeof aiStages
export const tripoImageModels = {
  banana: 'Nano Banana',
  banana_pro: 'Nano Banana Pro',
  banana2: 'Nano Banana 2',
  chat_image_1: 'GPT Image 1 (legacy)',
  'chat_image_1.5': 'GPT Image 1.5',
  chat_image_2: 'GPT Image 2'
} as const
const legacyTripoImageModels = {
  'gemini_2.5_flash_image_preview': 'banana',
  gemini_3_pro_image_preview: 'banana_pro',
  'gemini_3.1_flash_image_preview': 'banana2',
  gpt_4o: 'chat_image_1',
  'gpt_image_1.5': 'chat_image_1.5',
  gpt_image_2: 'chat_image_2'
} as const satisfies Record<string, keyof typeof tripoImageModels>
export const unavailableTripoImageModels = ['midjourney', 'flux.1_kontext_pro', 'flux.1_dev'] as const
export function tripoImageModelId(model: string): string {
  return Object.entries(legacyTripoImageModels).find(([id]) => id === model)?.[1] ?? model
}
export const aiStageSchema = z.enum(Object.keys(aiStages) as [AiStage, ...AiStage[]])
export const tripoCredentialEndpoints = {
  tripo: 'https://openapi.tripo3d.ai',
  'tripo-com': 'https://openapi.tripo3d.com'
} as const
export type TripoCredentialTarget = keyof typeof tripoCredentialEndpoints
export const aiCredentialTargetSchema = z.union([aiStageSchema, z.enum(['global', 'tripo', 'tripo-com'])])
export type AiCredentialTarget = z.infer<typeof aiCredentialTargetSchema>
export const workflowParameters = ['prompt', 'image', 'mesh', 'seed', 'steps', 'seconds', 'prefix', 'model', 'textEncoder', 'constraints', 'referenceStrength', 'video', 'clipStart', 'clipEnd', 'subject'] as const
export type WorkflowParameter = typeof workflowParameters[number]
export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>
const identifier = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_. -]+$/)
const outputKind = z.enum(['image', 'model', 'npz', 'bvh', 'metadata', 'text', 'json'])
export const workflowSchema = z.object({
  version: z.literal(1),
  prompt: z.record(identifier, z.object({ class_type: identifier, inputs: z.record(identifier, z.json()) }).strict()),
  bindings: z.array(z.object({
    parameter: z.enum(workflowParameters), node: identifier, input: identifier
  }).strict()).max(100),
  outputs: z.array(z.object({ kind: outputKind, node: identifier, field: identifier }).strict()).min(1).max(7)
}).strict().superRefine((value, ctx) => {
  if (!Object.keys(value.prompt).length || Object.keys(value.prompt).length > 300)
    ctx.addIssue({ code: 'custom', message: 'A workflow must contain 1-300 API-format ComfyUI nodes.' })
  const targets = new Set<string>()
  for (const binding of value.bindings) {
    if (!Object.hasOwn(value.prompt[binding.node]?.inputs ?? {}, binding.input))
      ctx.addIssue({ code: 'custom', message: `Binding refers to missing input ${binding.node}.${binding.input}.` })
    const target = `${binding.node}.${binding.input}`
    if (targets.has(target)) ctx.addIssue({ code: 'custom', message: 'Each workflow input can have only one binding.' })
    targets.add(target)
  }
  const outputs = new Set<string>()
  for (const output of value.outputs) {
    if (!Object.hasOwn(value.prompt, output.node) || outputs.has(output.kind))
      ctx.addIssue({ code: 'custom', message: 'Output nodes must exist and output kinds must be unique.' })
    outputs.add(output.kind)
  }
  if (JSON.stringify(value).length > 1024 * 1024)
    ctx.addIssue({ code: 'custom', message: 'Workflow JSON exceeds 1 MB.' })
  // Credentials belong in the OS vault, not templates, project history or exported manifests.
  const inspect = (item: unknown): void => {
    if (!item || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      if (/^(?:api[_-]?key|access[_-]?token|authorization|password|secret|token)$/i.test(key) && child)
        ctx.addIssue({ code: 'custom', message: 'Remove credentials from the workflow; use the encrypted API key field.' })
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        ctx.addIssue({ code: 'custom', message: 'Unsafe workflow property.' })
      inspect(child)
    }
  }
  inspect(value.prompt)
})
export type WorkflowTemplate = z.infer<typeof workflowSchema>

export function isLoopback(endpoint: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)
}

export function providerUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /[\\]/.test(value) || /%(?:2f|5c|2e)/i.test(url.pathname))
    throw new Error('Use an HTTP(S) endpoint without credentials, query parameters, fragments or encoded path separators.')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function tripoMeshLimits(model: string, smartLowPoly = false) {
  return {
    min: smartLowPoly ? 500 : 1,
    max: smartLowPoly ? 20_000 : model === 'v2.5-20250123' ? 500_000 : model === 'v3.0-20250812' ? 1_000_000 : 1_500_000,
    smartLowPolySupported: !['v2.5-20250123', 'P1-20260311'].includes(model)
  }
}

export const aiRouteSchema = z.object({
  provider: z.enum(['builtin', 'comfyui', 'api', 'tripo']),
  location: z.enum(['local', 'remote']),
  endpoint: z.string().max(2048).default(''),
  model: z.string().trim().max(200).default(''),
  minVramGB: z.number().finite().min(0).max(192).default(0),
  tripoMesh: z.object({
    maxTriangles: z.number().finite().int('Maximum triangles must be a whole number.').optional(),
    smartLowPoly: z.boolean().optional()
  }).strict().optional(),
  workflow: workflowSchema.optional()
}).strict().superRefine((route, ctx) => {
  if (route.tripoMesh) {
    if (route.provider !== 'tripo')
      ctx.addIssue({ code: 'custom', message: 'Triangle reduction settings require the Tripo provider.' })
    const { min, max, smartLowPolySupported } = tripoMeshLimits(route.model, route.tripoMesh.smartLowPoly)
    const count = route.tripoMesh.maxTriangles
    if (count !== undefined && (count < min || count > max))
      ctx.addIssue({ code: 'custom', message: `Maximum triangles must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')} for this Tripo model and mode.` })
    if (route.tripoMesh.smartLowPoly && !smartLowPolySupported)
      ctx.addIssue({ code: 'custom', message: 'Smart low-poly is not supported by this Tripo model. Turn it off or choose H3 v3.0/v3.1.' })
  }
  if (route.provider === 'builtin') {
    if (route.location !== 'local' || route.endpoint || route.workflow || route.model)
      ctx.addIssue({ code: 'custom', message: 'Built-in local selections use the existing Designer profiles and Kimodo encoder controls.' })
    return
  }
  try {
    const endpoint = providerUrl(route.endpoint)
    if (route.location === 'local' && !isLoopback(endpoint))
      throw new Error('Local routes must use loopback. Select Remote explicitly for LAN or cloud endpoints.')
    if (route.provider === 'tripo' && (route.location !== 'remote' || !Object.values(tripoCredentialEndpoints).some(origin => origin === endpoint)))
      throw new Error('Tripo requires its official HTTPS v3 endpoint and Remote execution.')
  } catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid provider endpoint.' }) }
  if (route.provider !== 'comfyui' && route.workflow)
    ctx.addIssue({ code: 'custom', message: 'ComfyUI workflow templates can only be used with a ComfyUI provider.' })
  if (route.provider === 'api' && !route.model)
    ctx.addIssue({ code: 'custom', message: 'Specify the model ID understood by your Studio API gateway.' })
}).transform(route => ({ ...route, endpoint: route.endpoint ? providerUrl(route.endpoint) : '' }))
export type AiRoute = z.infer<typeof aiRouteSchema>
export const localRoute: AiRoute = { provider: 'builtin', location: 'local', endpoint: '', model: '', minVramGB: 0 }
export const aiConfigurationSchema = z.object({
  version: z.literal(1),
  globalComfy: aiRouteSchema.optional(),
  stages: z.partialRecord(aiStageSchema, aiRouteSchema)
}).strict().superRefine((config, ctx) => {
  if (config.globalComfy && (config.globalComfy.provider !== 'comfyui' || config.globalComfy.workflow || config.globalComfy.model))
    ctx.addIssue({ code: 'custom', message: 'The global ComfyUI connection cannot have a stage-specific model or template.' })
  for (const [stage, route] of Object.entries(config.stages)) {
    if (route.tripoMesh && stage !== 'mesh')
      ctx.addIssue({ code: 'custom', message: 'Tripo triangle reduction settings apply only to 3D mesh generation.' })
    if (route.provider === 'tripo' && !['scene', 'tpose', 'mesh', 'texture', 'rig', 'segmentation'].includes(stage))
      ctx.addIssue({ code: 'custom', message: `Tripo is not a provider for ${stage}. Select a compatible ComfyUI workflow or API gateway.` })
    if (route.provider === 'comfyui' && ['naming', 'rig', 'texture', 'segmentation', 'landmarks', 'cloth', 'capture'].includes(stage) && !route.workflow)
      ctx.addIssue({ code: 'custom', message: `${stage} requires a custom ComfyUI workflow.` })
    if (route.workflow) {
      for (const binding of route.workflow.bindings) {
        if (binding.parameter === 'constraints' && route.workflow.prompt[binding.node]?.class_type === 'Kimodo_Sampler')
          ctx.addIssue({ code: 'custom', message: 'Kimodo_Sampler takes a server-local path and ignores inline JSON. Use Studio_Kimodo_Sampler from the supplied ComfyUI bridge for constraints.' })
      }
      const required = stage === 'motion' ? ['npz', 'bvh', 'metadata'] :
        stage === 'naming' ? ['text'] : ['landmarks', 'cloth', 'capture'].includes(stage) ? ['json'] :
          ['scene', 'tpose', 'cutout'].includes(stage) ? ['image'] : ['model']
      for (const kind of required) if (!route.workflow.outputs.some(output => output.kind === kind))
        ctx.addIssue({ code: 'custom', message: `${stage} workflow must declare its ${kind} output.` })
      for (const parameter of stage === 'motion' ? ['prompt', 'seed', 'steps', 'seconds', 'prefix', 'constraints'] :
        stage === 'capture' ? ['video', 'clipStart', 'clipEnd', 'prefix'] :
        ['tpose', 'cutout', 'mesh'].includes(stage) ? ['image', 'prefix'] :
          ['rig', 'texture', 'segmentation'].includes(stage) ? ['mesh', 'prefix'] : ['prompt', 'prefix']) {
        if (!route.workflow.bindings.some(binding => binding.parameter === parameter))
          ctx.addIssue({ code: 'custom', message: `${stage} workflow requires a ${parameter} binding.` })
      }
    }
  }
})
export type AiConfiguration = z.infer<typeof aiConfigurationSchema>
export const defaultAiConfiguration: AiConfiguration = { version: 1, stages: {} }
export function resolveAiRoute(config: AiConfiguration | undefined, stage: AiStage): AiRoute {
  return config?.stages[stage] ?? (['scene', 'tpose', 'cutout', 'mesh', 'motion'].includes(stage) ? config?.globalComfy : undefined) ?? localRoute
}
export function resolveAiCredentialRoute(config: AiConfiguration | undefined, value: unknown): AiRoute {
  const target = aiCredentialTargetSchema.parse(value)
  if (target === 'tripo' || target === 'tripo-com')
    return { provider: 'tripo', location: 'remote', endpoint: tripoCredentialEndpoints[target], model: '', minVramGB: 0 }
  const route = target === 'global' ? config?.globalComfy : resolveAiRoute(config, target)
  if (!route) throw new Error('Save a global ComfyUI endpoint first.')
  return route
}
export function aiRouteLabel(config: AiConfiguration | undefined, stage: AiStage): string {
  const route = resolveAiRoute(config, stage)
  return `${route.location === 'remote' ? 'Remote' : 'Local'} / ${route.provider === 'builtin' ? 'built-in' : route.provider === 'api' ? 'custom API' : route.provider === 'tripo' ? 'Tripo (paid)' : 'ComfyUI'}${route.model ? ` / ${aiModelLabel(route)}` : ''}`
}
export function aiModelLabel(route: Pick<AiRoute, 'provider' | 'model'>): string {
  return route.provider === 'tripo' ? Object.entries(tripoImageModels).find(([id]) => id === tripoImageModelId(route.model))?.[1] ?? route.model : route.model
}
export interface AiProvenance {
  stage: AiStage
  route: AiRoute
  configurationHash: string
  workflowHash?: string
  createdAt: string
  taskId?: string
  taskIds?: string[]
}
export interface AiHardware {
  platform: string
  architecture: string
  cpu: string
  ramGB: number
  freeRamGB: number
  devices: { name: string; type?: string; totalGB: number; freeGB: number }[]
  warning?: string
}
export interface AiConsent {
  id: string
  stage: AiStage
  endpoint: string
  model: string
  provider: AiRoute['provider']
  inputs: string[]
}
