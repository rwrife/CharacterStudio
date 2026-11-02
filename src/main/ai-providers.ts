import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  aiConfigurationSchema, defaultAiConfiguration, resolveAiRoute, workflowSchema,
  type AiConfiguration, type AiConsent, type AiHardware, type AiProvenance, type AiRoute,
  type AiStage, type Workflow, type WorkflowParameter, type WorkflowTemplate
} from '../shared/ai'
import type { Settings } from '../shared/types'
import { AiCredentials } from './ai-credentials'
import { AiNetwork, decodeBase64, downloadTripoOutput } from './ai-network'
import { api, buildPrompt } from './comfy'
import type { GenerateRequest } from '../shared/types'

const MB = 1024 * 1024
const taskIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
export const motionMetadataSchema = z.object({
  num_joints: z.literal(77), num_frames: z.number().int().min(2).max(1800),
  fps: z.number().finite().min(1).max(120)
})
export function validateMotionMetadata(value: unknown, seconds: number, prompt: string) {
  const metadata = motionMetadataSchema.parse(value)
  const expected = Math.floor(seconds * metadata.fps) * prompt.split('.').filter(p => p.trim()).length
  if (metadata.num_frames !== expected)
    throw new Error(`Provider returned ${metadata.num_frames} frames; expected ${expected}. Refusing incorrect duration or endpoint indices.`)
  return metadata
}
export function hashConfiguration(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) :
    item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export function bindWorkflow(template: WorkflowTemplate, parameters: Partial<Record<WorkflowParameter, unknown>>): Workflow {
  const graph: Workflow = structuredClone(template.prompt)
  for (const binding of template.bindings) {
    const value = parameters[binding.parameter]
    if (value === undefined) throw new Error(`Workflow needs a ${binding.parameter} parameter which this action cannot supply.`)
    graph[binding.node].inputs[binding.input] = value
  }
  return graph
}
export function nativeTemplate(prompt: Workflow, kind: 'image' | 'model', node: string): WorkflowTemplate {
  return workflowSchema.parse({ version: 1, prompt, bindings: [], outputs: [{ kind, node, field: kind === 'image' ? 'images' : '3d' }] })
}
export function motionProviderTemplate(request: GenerateRequest, parameters: Partial<Record<WorkflowParameter, unknown>>, encoder: Settings['textEncoder']): WorkflowTemplate {
  const prompt = buildPrompt(request, String(parameters.prefix), String(parameters.constraints), encoder)
  prompt['1'].inputs.model = parameters.model || 'Kimodo-SOMA-RP-v1'
  prompt['3'].class_type = 'Studio_Kimodo_Sampler'
  prompt['7'] = { class_type: 'Studio_MotionFile', inputs: { file_path: ['4', 0] } }
  prompt['8'] = { class_type: 'Studio_MotionFile', inputs: { file_path: ['5', 0] } }
  return workflowSchema.parse({ version: 1, prompt, bindings: [], outputs: [
    { kind: 'npz', node: '7', field: 'files' }, { kind: 'bvh', node: '8', field: 'files' },
    { kind: 'metadata', node: '6', field: 'motion_json' }
  ] })
}
interface Execution {
  stage: AiStage
  route?: AiRoute
  prompt: string
  seed: number
  steps: number
  seconds?: number
  referenceStrength?: number
  textEncoder?: string
  image?: string
  mesh?: string
  constraints?: unknown
  native?: (parameters: Partial<Record<WorkflowParameter, unknown>>) => WorkflowTemplate
  nativeBudgetGB?: number
  signal: AbortSignal
  submitted: (id: string) => void
  progress: (message: string) => void
  record: (provenance: AiProvenance, workflow?: Workflow) => Promise<void>
}
export interface AiResult {
  image?: Buffer
  model?: Buffer
  npz?: Buffer
  bvh?: Buffer
  metadata?: z.infer<typeof motionMetadataSchema>
  text?: string
  json?: unknown
}
const fileDescriptor = z.object({
  filename: z.string().min(1).max(255).regex(/^[^\\/:]+$/),
  subfolder: z.string().max(1024),
  type: z.literal('output')
}).refine(file => !file.filename.includes('..') && !file.subfolder.includes('\\') &&
  !file.subfolder.split('/').some(part => part === '..' || part === '.') &&
  !file.subfolder.startsWith('/') && !file.subfolder.includes(':') && !file.subfolder.includes('%'), 'Invalid ComfyUI output descriptor.')

export class AiProviders {
  private configuration: AiConfiguration
  private history: { createdAt: string; configuration: AiConfiguration }[]
  private path: string
  credentials?: AiCredentials
  confirm: (request: AiConsent, signal: AbortSignal) => Promise<boolean> = async () => { throw new Error('Remote approval requires the visible desktop window.') }

  constructor(root: string, private settings: () => Settings) {
    this.path = join(root, 'ai-providers.json')
    const stored = existsSync(this.path) ? z.object({
      configuration: aiConfigurationSchema,
      history: z.array(z.object({ createdAt: z.string(), configuration: aiConfigurationSchema }))
    }).parse(JSON.parse(readFileSync(this.path, 'utf8'))) : { configuration: defaultAiConfiguration, history: [] }
    this.configuration = stored.configuration
    this.history = stored.history
  }
  snapshot() { return structuredClone(this.configuration) }
  route(stage: AiStage) { return structuredClone(resolveAiRoute(this.configuration, stage)) }
  save(value: AiConfiguration) {
    const configuration = aiConfigurationSchema.parse(value)
    const history = [...this.history, { createdAt: new Date().toISOString(), configuration }]
    writeFileSync(this.path + '.tmp', JSON.stringify({ configuration, history }, null, 2))
    renameSync(this.path + '.tmp', this.path)
    this.configuration = configuration
    this.history = history
  }
  async hardware(): Promise<AiHardware> {
    const result: AiHardware = {
      platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model ?? 'Unknown CPU',
      ramGB: totalmem() / 2 ** 30, freeRamGB: freemem() / 2 ** 30, devices: []
    }
    try {
      const stats = z.object({ devices: z.array(z.object({
        name: z.string(), type: z.string(), vram_total: z.number().nonnegative(), vram_free: z.number().nonnegative()
      })) }).parse(await api(this.settings().comfyUrl, '/system_stats'))
      result.devices = stats.devices.filter(device => device.type !== 'cpu').map(device => ({
        name: device.name, totalGB: device.vram_total / 2 ** 30, freeGB: device.vram_free / 2 ** 30
      }))
      if (!result.devices.length) result.warning = 'Local ComfyUI reports no GPU. GPU compatibility is unknown; no profile was changed.'
    } catch { result.warning = 'Local GPU telemetry is unavailable. Start local ComfyUI to detect total/free VRAM; no remote server is queried.' }
    return result
  }
  async balance(route: AiRoute, signal: AbortSignal) {
    if (route.provider !== 'tripo') throw new Error('Credit balance is available for Tripo only.')
    return z.object({ balance: z.number().finite(), frozen: z.number().finite() }).parse(
      await this.network(route).tripo('/v3/account/balance', signal))
  }
  private network(route: AiRoute) {
    const token = this.credentials?.get(route)
    if (route.provider === 'tripo' && !token) throw new Error('Save a Tripo API key in Model & workflow providers first. Tripo is a paid service with separate API credits.')
    return new AiNetwork(route, token)
  }
  async execute(options: Execution): Promise<AiResult> {
    const requested = options.route ?? this.route(options.stage)
    const route = requested.provider === 'builtin' ? { ...requested, provider: 'comfyui' as const, endpoint: this.settings().comfyUrl } : requested
    const { signal } = options
    if (route.provider === 'comfyui' && !route.workflow && !options.native)
      throw new Error(`${options.stage} requires a custom ComfyUI template with input and output mappings.`)
    signal.throwIfAborted()
    if (route.location === 'remote') {
      options.progress('Waiting for approval in the desktop. No prompt or asset has been sent.')
      const approved = await this.confirm({
        id: randomUUID(), stage: options.stage, endpoint: route.endpoint, model: route.model,
        provider: route.provider, inputs: ['Prompt and generation settings', ...(options.image ? ['Character reference image'] : []),
          ...(options.mesh ? ['Character mesh and embedded textures'] : []), ...(options.constraints ? ['Actual incoming / endpoint pose constraints'] : [])]
      }, signal)
      if (!approved) throw new Error('Remote execution was not approved. No prompt or asset was transmitted.')
    }
    signal.throwIfAborted()
    const network = this.network(route)
    const provenance: AiProvenance = {
      stage: options.stage, route: structuredClone(route), configurationHash: hashConfiguration(route),
      createdAt: new Date().toISOString(), workflowHash: route.workflow ? hashConfiguration(route.workflow) : undefined
    }
    await options.record(provenance)
    const submitted = async (id: string) => {
      provenance.taskId = id
      provenance.taskIds = [...(provenance.taskIds ?? []), id]
      options.submitted(id)
      await options.record(provenance)
    }
    if (route.provider === 'comfyui') return this.comfy(network, options, provenance, submitted)
    if (route.provider === 'api') return this.gateway(network, options, submitted)
    if (route.provider === 'tripo') return this.tripo(network, options, submitted)
    throw new Error('Unsupported AI provider.')
  }
  private async input(path: string, maxBytes = 20 * MB) {
    const size = (await stat(path)).size
    if (!size || size > maxBytes) throw new Error(`Provider input must be nonempty and no larger than ${maxBytes / MB} MB.`)
    const bytes = await readFile(path)
    if (!bytes.length || bytes.length > maxBytes) throw new Error('Provider input changed size during reading.')
    return bytes
  }
  private async comfy(network: AiNetwork, options: Execution, provenance: AiProvenance, submitted: (id: string) => Promise<void>): Promise<AiResult> {
    const { signal, stage } = options
    const parameters: Partial<Record<WorkflowParameter, unknown>> = {
      prompt: options.prompt, seed: options.seed, steps: options.steps, seconds: options.seconds,
      model: network.route.model, textEncoder: options.textEncoder ?? this.settings().textEncoder ?? 'llm2vec',
      referenceStrength: options.referenceStrength ?? 0.3, constraints: JSON.stringify(options.constraints ?? {}),
      prefix: `studio_${randomUUID().replaceAll('-', '')}`,
      image: options.image ? 'studio_input.png' : '', mesh: options.mesh ? 'studio_input.glb' : ''
    }
    const template = network.route.workflow ?? options.native!(parameters)
    if (options.image && network.route.workflow && !template.bindings.some(binding => binding.parameter === 'image'))
      throw new Error('This workflow has no image binding. It cannot preserve the supplied character reference.')
    const nodes = z.record(z.string(), z.object({ api_node: z.boolean().optional() }).passthrough())
      .parse(await network.json('/object_info', signal))
    for (const node of Object.values(template.prompt)) {
      if (!Object.hasOwn(nodes, node.class_type)) throw new Error(`Required ComfyUI node unavailable: ${node.class_type}.${node.class_type.startsWith('Studio_') ? ' Copy backend/studio_provider_nodes into custom_nodes on the selected server and restart it (see README).' : ''}`)
      if (network.route.location === 'local' && nodes[node.class_type].api_node)
        throw new Error('Local routes cannot execute cloud/API nodes. Select an explicit Remote provider instead.')
    }
    if (network.route.location === 'local' && /https?:\/\//i.test(JSON.stringify(template.prompt)))
      throw new Error('Local templates cannot contain remote URLs. Use a Remote route and review its data transfer.')
    const budget = network.route.minVramGB || options.nativeBudgetGB || 0
    if (network.route.location === 'local' && budget) {
      const stats = z.object({ devices: z.array(z.object({ type: z.string(), vram_free: z.number() })) }).parse(await network.json('/system_stats', signal))
      if (!stats.devices.some(device => device.type !== 'cpu' && device.vram_free / 2 ** 30 >= budget))
        throw new Error(`This profile requires an estimated ${budget} GiB free on one GPU. Choose a lower-memory model or a Remote route.`)
    }
    for (const [parameter, path] of [['image', options.image], ['mesh', options.mesh]] as const) {
      if (!path) continue
      const name = `${randomUUID()}.${parameter === 'image' ? 'png' : 'glb'}`
      const form = new FormData()
      form.append('image', new Blob([new Uint8Array(await this.input(path, parameter === 'mesh' ? 50 * MB : 20 * MB))]), name)
      form.append('overwrite', 'false')
      const uploaded = z.object({ name: z.string(), subfolder: z.string(), type: z.literal('input') }).parse(await network.json('/upload/image', signal, form))
      if (uploaded.name !== name || uploaded.subfolder) throw new Error('ComfyUI returned an unexpected uploaded input location.')
      parameters[parameter] = uploaded.name
    }
    const materialized = network.route.workflow ? template : options.native!(parameters)
    const graph = bindWorkflow(materialized, parameters)
    provenance.workflowHash = hashConfiguration(graph)
    await options.record(provenance, graph)
    const id = randomUUID()
    // Record before POST; never retry a potentially billable submission.
    await submitted(id)
    let complete = false
    try {
      const response = z.object({ prompt_id: taskIdSchema }).parse(await network.json('/prompt', signal, { prompt: graph, prompt_id: id, client_id: randomUUID() }))
      if (response.prompt_id !== id) throw new Error('ComfyUI did not preserve the submitted job ID.')
      const deadline = Date.now() + 60 * 60 * 1000
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        const history = z.record(z.string(), z.object({
          status: z.object({ completed: z.boolean(), status_str: z.string() }),
          outputs: z.record(z.string(), z.record(z.string(), z.unknown()))
        }).passthrough()).parse(await network.json(`/history/${id}`, signal, undefined, undefined, 100 * MB))
        const item = history[id]
        if (item?.status.status_str === 'error') throw new Error('ComfyUI generation failed. Inspect this prompt in the selected backend; no partial output was published.')
        if (item?.status.completed) {
          complete = true
          const result: AiResult = {}
          for (const output of materialized.outputs) {
            const values = item.outputs[output.node]?.[output.field]
            if (!Array.isArray(values) || values.length !== 1) throw new Error(`ComfyUI must return exactly one ${output.kind} output.`)
            const value: unknown = values[0]
            if (output.kind === 'metadata') {
              result.metadata = validateMotionMetadata(typeof value === 'string' ? JSON.parse(value) : value, options.seconds!, options.prompt)
            } else if (output.kind === 'text') result.text = z.string().trim().min(1).max(100).parse(value)
            else if (output.kind === 'json') result.json = value
            else {
              const file = fileDescriptor.parse(value)
              const extension = output.kind === 'image' ? '.png' : output.kind === 'model' ? '.glb' : '.' + output.kind
              if (!file.filename.toLowerCase().endsWith(extension) || !file.filename.startsWith(String(parameters.prefix) + '_'))
                throw new Error('ComfyUI output does not match this job prefix and required file format.')
              const query = new URLSearchParams(file)
              result[output.kind] = await network.request(`/view?${query}`, signal, undefined, undefined, output.kind === 'image' ? 20 * MB : 500 * MB)
            }
          }
          this.requireResult(stage, result)
          return result
        }
        options.progress(`Generating ${stage} with ${network.route.location} ComfyUI.`)
        await delay(1500, undefined, { signal })
      }
      throw new Error('ComfyUI generation exceeded one hour.')
    } catch (error) {
      if (!complete) {
        try { await network.json(`/api/jobs/${id}/cancel`, AbortSignal.timeout(15_000), {}) }
        catch { throw new Error(`Generation stopped, but cancellation of ComfyUI prompt ${id} could not be confirmed. Inspect that job before retrying.`) }
      }
      throw error
    }
  }
  private requireResult(stage: AiStage, result: AiResult) {
    const valid = stage === 'naming' ? !!result.text : stage === 'motion' ? !!result.npz && !!result.bvh && !!result.metadata :
      ['scene', 'tpose', 'cutout'].includes(stage) ? !!result.image : ['landmarks', 'cloth'].includes(stage) ? result.json !== undefined : !!result.model
    if (!valid) throw new Error(`Provider completed without the required ${stage} output. No fallback or partial result was published.`)
  }
  private async gateway(network: AiNetwork, options: Execution, submitted: (id: string) => Promise<void>): Promise<AiResult> {
    const { signal } = options
    const id = randomUUID()
    const inputs: { kind: string; mimeType: string; base64: string }[] = []
    if (options.image) inputs.push({ kind: 'image', mimeType: 'image/png', base64: (await this.input(options.image)).toString('base64') })
    if (options.mesh) inputs.push({ kind: 'mesh', mimeType: 'model/gltf-binary', base64: (await this.input(options.mesh, 50 * MB)).toString('base64') })
    await submitted(id)
    let complete = false
    try {
      const response = z.object({ id: taskIdSchema }).parse(await network.json('/jobs', signal, {
        version: 1, id, stage: options.stage, model: network.route.model, prompt: options.prompt,
        seed: options.seed, steps: options.steps, seconds: options.seconds, textEncoder: options.textEncoder,
        referenceStrength: options.referenceStrength, constraints: options.constraints, inputs
      }))
      if (response.id !== id) throw new Error('The API gateway must preserve the supplied job ID for safe cancellation and deduplication.')
      const deadline = Date.now() + 60 * 60 * 1000
      while (Date.now() < deadline) {
        const item = z.object({ status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']), outputs: z.record(z.string(), z.unknown()).optional() })
          .parse(await network.json(`/jobs/${id}`, signal, undefined, undefined, 700 * MB))
        if (item.status === 'failed' || item.status === 'cancelled') { complete = true; throw new Error(`API generation ${item.status}. Inspect the job at your provider.`) }
        if (item.status === 'complete') {
          complete = true
          const output = item.outputs ?? {}
          const result: AiResult = {}
          for (const kind of ['image', 'model', 'npz', 'bvh'] as const)
            if (output[kind] !== undefined) result[kind] = decodeBase64(output[kind], kind === 'image' ? 20 * MB : 500 * MB)
          if (output.metadata !== undefined) result.metadata = validateMotionMetadata(output.metadata, options.seconds!, options.prompt)
          if (output.text !== undefined) result.text = z.string().trim().min(1).max(100).parse(output.text)
          if (output.json !== undefined) result.json = output.json
          this.requireResult(options.stage, result)
          return result
        }
        options.progress(`Waiting for ${network.route.model} at the selected API gateway.`)
        await delay(1500, undefined, { signal })
      }
      throw new Error('API generation exceeded one hour.')
    } catch (error) {
      if (!complete) {
        try { await network.json(`/jobs/${id}`, AbortSignal.timeout(15_000), undefined, 'DELETE') }
        catch { throw new Error(`Generation stopped, but remote cancellation of job ${id} could not be confirmed. It may continue and incur charges; inspect it before retrying.`) }
      }
      throw error
    }
  }
  private async tripo(network: AiNetwork, options: Execution, submitted: (id: string) => Promise<void>): Promise<AiResult> {
    const { signal, stage } = options
    let id = ''
    const waitForTask = async (taskId: string) => {
      const deadline = Date.now() + 60 * 60 * 1000
      while (Date.now() < deadline) {
        const task = z.object({
          status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'banned', 'expired']),
          output: z.object({ model_url: z.string().optional(), generated_image_url: z.string().optional() }).optional()
        }).parse(await network.tripo(`/v3/tasks/${taskId}`, signal))
        if (['failed', 'cancelled', 'banned', 'expired'].includes(task.status)) throw new Error(`Tripo task ${taskId} ${task.status}. Check its task details and available API credits.`)
        if (task.status === 'success') return task.output
        options.progress(`Tripo paid task ${taskId}: ${task.status}.`)
        await delay(2000, undefined, { signal })
      }
      throw new Error(`Tripo task ${taskId} exceeded one hour.`)
    }
    try {
      if (['scene', 'tpose'].includes(stage) && options.prompt.length > 1024)
        throw new Error('Tripo image prompts support at most 1,024 characters. Shorten the character description and art style before retrying; no image was uploaded.')
      if (options.image && ['midjourney', 'flux.1_dev'].includes(network.route.model))
        throw new Error('The selected Tripo image model is text-only. Choose Nano Banana, GPT Image or FLUX.1 Kontext for reference images and T-pose editing. No model substitution was made.')
      let input: string | undefined
      const path = options.mesh ?? options.image
      if (path) {
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(await this.input(path, options.mesh ? 50 * MB : 20 * MB))]), `input.${options.mesh ? 'glb' : 'png'}`)
        input = z.object({ file_token: z.string().min(1).max(256) }).parse(await network.tripo('/v3/files', signal, form)).file_token
      }
      if (options.mesh) {
        id = z.object({ task_id: taskIdSchema }).parse(await network.tripo('/v3/models/import', signal, { input })).task_id
        await submitted(id)
        await waitForTask(id)
        input = id
      }
      const route = stage === 'scene' || stage === 'tpose' ? input ? '/v3/generation/image-to-image' : '/v3/generation/text-to-image' :
        stage === 'mesh' ? '/v3/generation/image-to-model' : stage === 'rig' ? '/v3/animations/rig' :
          stage === 'texture' ? '/v3/models/texture' : stage === 'segmentation' ? '/v3/mesh/segment' : ''
      if (!route) throw new Error(`Tripo does not implement ${stage}.`)
      const body = {
        ...(input ? { input } : {}), ...(network.route.model ? { model: network.route.model } : {}),
        ...(['scene', 'tpose'].includes(stage) ? { prompt: options.prompt, ...(stage === 'tpose' ? { t_pose: true } : {}) } : {}),
        ...(stage === 'mesh' ? { model_seed: options.seed, texture: true, pbr: true } : {}),
        ...(stage === 'rig' ? { rig_type: 'biped', out_format: 'glb', spec: 'tripo' } : {}),
        ...(stage === 'texture' ? { texture: true, pbr: true, texture_seed: options.seed, texture_prompt: { text: options.prompt } } : {})
      }
      id = z.object({ task_id: taskIdSchema }).parse(await network.tripo(route, signal, body)).task_id
      await submitted(id)
      const output = await waitForTask(id)
      const image = ['scene', 'tpose'].includes(stage)
      const url = image ? output?.generated_image_url : output?.model_url
      if (!url) throw new Error('Tripo completed without the required image or GLB URL.')
      return { [image ? 'image' : 'model']: await downloadTripoOutput(url, signal, image ? 20 * MB : 500 * MB) }
    } catch (error) {
      if (signal.aborted) throw new Error(`Stopped waiting for Tripo${id ? ` task ${id}` : ''}. Tripo does not expose task cancellation in this adapter; submitted work may continue and incur charges.`)
      if (id) throw new Error(`${error instanceof Error ? error.message : 'Tripo request failed'} Inspect Tripo task ${id} before retrying. Submitted tasks may still incur charges.`)
      throw error
    }
  }
}
