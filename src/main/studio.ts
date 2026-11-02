import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, createWriteStream } from 'node:fs'
import { access, copyFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { Character, Check, GenerateRequest, Job, RigSetup, SkinningMode, Settings, Snapshot, MotionPlan, BatchRequest, Batch, MotionNode, GraphContext } from '../shared/types'
import { defaultLandmarks } from '../shared/rig'
import { createBatchItems } from '../shared/plans'
import { errorText, generateSchema, settingsSchema, setupSchema, skinningSchema, planSchema, batchSchema } from './validation'
import { api, cancelMotion, generateMotion } from './comfy'
import { runProcess } from './process'
import { validateCharacterGlb, validateDesignGlb } from './export-validation'
import { meshTextureProfile } from '../shared/designer'
import { Designer } from './designer'
import { bundledBlenderPath, comfyPythonPath, defaultComfyRoot } from './native-runtime'

interface StoredCharacter extends Character { rigDirectory?: string }
interface StoredState extends Omit<Snapshot, 'characters' | 'designer'> { characters: StoredCharacter[] }
const terminal = new Set(['complete', 'failed', 'cancelled'])

export class Studio {
  private state: StoredState
  private active?: { job: Job; controller: AbortController; settings: Settings }
  private managedComfy?: ChildProcess
  private startingComfy = false
  private batchController?: AbortController
  private lifetime = new AbortController()
  private designerBusy = false
  readonly designer: Designer
  readonly assets = new Map<string, string>()
  onUpdate: (snapshot: Snapshot) => void = () => {}

  constructor(readonly root: string, readonly appRoot: string, decodeImage: (file: string, cutout?: boolean, squareSize?: number) => Promise<Buffer> = async () => { throw new Error('Image decoding requires the desktop app.') }) {
    mkdirSync(root, { recursive: true })
    const comfyRoot = defaultComfyRoot()
    const statePath = join(root, 'studio.json')
    this.state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as StoredState : {
      settings: {
        comfyUrl: 'http://127.0.0.1:8189', comfyRoot, comfyOutput: join(comfyRoot, 'output'),
        blenderPath: bundledBlenderPath(appRoot)
      },
      characters: [], jobs: [], plans: [], batches: []
    }
    this.state.plans ??= []
    this.state.plans = this.state.plans.map(plan => planSchema.parse(plan))
    this.state.batches ??= []
    this.state.settings = settingsSchema.parse(this.state.settings)
    for (const job of this.state.jobs) if (!terminal.has(job.stage)) {
      job.stage = 'failed'
      job.message = 'App closed before this job finished. Partial files are not a completed result.' +
        (job.promptId ? ` Inspect ComfyUI prompt ${job.promptId} before retrying.` : '')
    }
    for (const batch of this.state.batches) if (batch.status === 'running') {
      batch.status = 'failed'
      for (const item of batch.items) if (item.status === 'pending' || item.status === 'running') {
        item.status = 'blocked'; item.message = 'App closed before this item completed. Run this saved batch again to retry.'
      }
    }
    this.designer = new Designer(root, appRoot, this.assets, () => this.state.settings, () => {
      if (this.designerBusy || this.active || this.batchController || this.startingComfy)
        throw new Error('Designer and Animator share one local job slot. Wait for the current operation or cancel it.')
      this.designerBusy = true
      return () => { this.designerBusy = false }
    }, () => this.onUpdate(this.snapshot()), decodeImage)
    this.refreshAssets()
    this.persist()
  }

  private asset(key: string, file: string): string {
    this.assets.set(key, file)
    return `studio://asset/${key}`
  }

  private refreshAssets() {
    for (const c of this.state.characters) {
      c.previewUrl = this.asset(`${c.id}-input`, join(this.root, 'characters', c.id, 'preview.glb'))
      if (c.rigged && c.rigDirectory) c.rigPreviewUrl = this.asset(`${c.id}-rig`, join(c.rigDirectory, 'rigged.glb'))
    }
    for (const j of this.state.jobs) if (j.stage === 'complete' && j.kind === 'generate') {
      j.previewUrl = this.asset(`${j.id}-output`, join(this.root, 'jobs', j.id, 'animated.glb'))
      if (j.outputFiles?.includes('clip.glb')) j.clipPreviewUrl = this.asset(`${j.id}-clip`, join(this.root, 'jobs', j.id, 'clip.glb'))
      if (j.outputFiles?.includes('transition.glb')) j.transitionPreviewUrl = this.asset(`${j.id}-transition`, join(this.root, 'jobs', j.id, 'transition.glb'))
    }
  }

  snapshot(): Snapshot {
    return structuredClone({
      ...this.state, designer: this.designer.snapshot(), characters: this.state.characters.map(({ rigDirectory: _, ...character }) => character)
    })
  }

  private persist() {
    const file = join(this.root, 'studio.json')
    writeFileSync(file + '.tmp', JSON.stringify(this.state, null, 2))
    renameSync(file + '.tmp', file)
    this.onUpdate(this.snapshot())
  }

  saveSettings(value: Settings) {
    if (this.designerBusy || this.active || this.startingComfy || this.batchController) throw new Error('Wait for the current operation before changing backend settings.')
    this.state.settings = settingsSchema.parse(value)
    this.persist()
    return this.state.settings
  }

  private character(id: string): StoredCharacter {
    const c = this.state.characters.find(c => c.id === id)
    if (!c) throw new Error('Character not found. Import the FBX again.')
    return c
  }

  saveSetup(id: string, value: RigSetup): Character {
    if (this.designerBusy || this.active || this.batchController) throw new Error('Wait for the current job before changing the rig.')
    const c = this.character(id)
    c.setup = setupSchema.parse(value)
    c.rigged = false
    c.rigPreviewUrl = undefined
    c.rigWarnings = undefined
    this.persist()
    return this.snapshot().characters.find(c => c.id === id)!
  }

  private update(job: Job, stage: Job['stage'], message: string, progress: number) {
    Object.assign(job, { stage, message, progress })
    this.persist()
  }

  private async job(kind: Job['kind'], characterId: string, name: string, work: (job: Job, signal: AbortSignal, settings: Settings) => Promise<void>, batchOwned = false): Promise<Job> {
    if (this.designerBusy || this.active || (this.batchController && !batchOwned)) throw new Error('A designer/character job or batch is already running. Cancel it or wait for completion.')
    const job: Job = { id: randomUUID(), characterId, characterName: name, kind, stage: kind === 'import' ? 'importing' : kind === 'rig' ? 'rigging' : 'preflight', message: 'Starting', progress: 0, createdAt: new Date().toISOString() }
    const settings = structuredClone(this.state.settings)
    const controller = new AbortController()
    const signal = this.batchController ? AbortSignal.any([controller.signal, this.batchController.signal]) : controller.signal
    this.active = { job, controller, settings }
    this.state.jobs.unshift(job)
    mkdirSync(join(this.root, 'jobs', job.id), { recursive: true })
    this.persist()
    try {
      await work(job, signal, settings)
      signal.throwIfAborted()
      this.update(job, 'complete', kind === 'generate' ? 'Animated character ready' : kind === 'rig' ? 'Rigged mesh ready for motion' : 'Character imported', 100)
      return job
    } catch (error) {
      let cleanup = ''
      if (job.promptId) {
        try { await cancelMotion(settings.comfyUrl, job.promptId) }
        catch (cancelError) { cleanup = ` Could not cancel this ComfyUI prompt: ${errorText(cancelError)}. Check prompt ${job.promptId} in ComfyUI.` }
      }
      this.update(job, signal.aborted ? 'cancelled' : 'failed', (signal.aborted ? 'Job cancelled. No completed character output was published.' : errorText(error)) + cleanup, job.progress)
      throw new Error(job.message)
    } finally {
      this.active = undefined
      this.persist()
    }
  }

  private async blender(job: Job, request: Record<string, unknown>, signal: AbortSignal, settings: Settings) {
    const dir = join(this.root, 'jobs', job.id)
    const path = join(dir, `request-${request.command}.json`)
    await writeFile(path, JSON.stringify(request))
    await runProcess(settings.blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', join(this.appRoot, 'backend', 'character.py'), '--', path], {
      signal, log: join(dir, 'backend.log'),
      onLine: line => {
        if (!line.startsWith('STUDIO:')) return
        const event = JSON.parse(line.slice(7))
        if (job.kind === 'rig' && event.stage === 'failed' && event.code === 'unweighted-skin') job.rigFailure = 'unweighted'
        if (event.stage !== 'failed') this.update(job, event.stage, event.message, event.progress)
      }
    })
  }

  async importCharacter(input: string, name = basename(input), requiredTextureSize?: number): Promise<Character> {
    const extension = input.toLowerCase().endsWith('.glb') ? 'glb' : 'fbx'
    if (!input.toLowerCase().endsWith('.' + extension)) throw new Error('Select an FBX or generated GLB character file.')
    if ((await stat(input)).size > 500 * 1024 * 1024) throw new Error('Character exceeds the 500 MB import limit.')
    const id = randomUUID()
    const output = join(this.root, 'characters', id)
    await this.job('import', id, name, async (job, signal, settings) => {
      mkdirSync(output, { recursive: true })
      await copyFile(input, join(output, 'original.' + extension))
      await this.blender(job, { command: 'import', input, output }, signal, settings)
      if (requiredTextureSize) await validateDesignGlb(join(output, 'preview.glb'), requiredTextureSize)
      signal.throwIfAborted()
      const report = JSON.parse(readFileSync(join(output, 'import-report.json'), 'utf8'))
      this.state.characters.unshift({
        id, name, importedAt: new Date().toISOString(), previewUrl: this.asset(`${id}-input`, join(output, 'preview.glb')),
        vertices: report.vertices, meshes: report.meshes, warnings: report.warnings,
        setup: { rotation: report.suggestedRotation, landmarks: defaultLandmarks() }, rigged: false
      })
    })
    return this.snapshot().characters.find(c => c.id === id)!
  }

  async importDesign(id: string): Promise<Character> {
    const assigned = this.designer.assignedCharacter(id)
    if (assigned) {
      const character = this.snapshot().characters.find(c => c.id === assigned)
      if (!character) throw new Error('Previously imported design character is missing.')
      return character
    }
    const design = this.designer.snapshot().designs.find(design => design.id === id)
    const character = await this.importCharacter(this.designer.output(id, 'model'), this.designer.title(id),
      design?.modelTextured && design.sources?.model?.kind === 'generated' && design.config.meshProfile === 'textured' ? meshTextureProfile.textureSize : undefined)
    this.designer.assign(id, character.id)
    return character
  }

  async rig(id: string, batchOwned = false, value: SkinningMode = 'automatic') {
    const skinning = skinningSchema.parse(value)
    const character = this.character(id)
    await this.job('rig', id, character.name, async (job, signal, settings) => {
      const output = join(this.root, 'jobs', job.id)
      await this.blender(job, { command: 'rig', input: join(this.root, 'characters', id, 'character.blend'), setup: character.setup, skinning, output }, signal, settings)
      await validateCharacterGlb(join(output, 'rigged.glb'), false)
      const report = JSON.parse(readFileSync(join(output, 'rig-report.json'), 'utf8'))
      signal.throwIfAborted()
      character.rigDirectory = output
      character.rigged = true
      character.rigPreviewUrl = this.asset(`${id}-rig`, join(output, 'rigged.glb'))
      character.rigWarnings = report.warnings
      job.warnings = report.warnings
    }, batchOwned)
  }

  async generate(value: GenerateRequest, batch?: { id: string; nodeId: string; label: string; reuseJobId?: string; node: MotionNode; context: GraphContext }) {
    const request = generateSchema.parse(value)
    const graph = batch && !batch.node.legacySegments ? batch : undefined
    const character = this.character(request.characterId)
    if (!character.rigged || !character.rigDirectory) throw new Error('Fit the landmarks and create a validated rig before generating motion.')
    const parent = request.parentJobId ? this.state.jobs.find(j => j.id === request.parentJobId) : undefined
    if (request.parentJobId && (!parent || parent.stage !== 'complete' || parent.kind !== 'generate' || parent.characterId !== character.id))
      throw new Error('Choose a completed motion from this character as the branch parent.')
    if (parent && parent.inPlace !== request.inPlace) throw new Error('Use the same root-motion mode as the parent clip.')
    if (parent) {
      const report = JSON.parse(readFileSync(join(this.root, 'jobs', parent.id, 'animation-report.json'), 'utf8'))
      const segments = request.prompt.split('.').filter(p => p.trim()).length
      if (report.frames + Math.floor((request.seconds * segments + (graph?.context.transitionSeconds ?? 0)) * report.fps) - 1 > 1800)
        throw new Error('The full branch would exceed 60 seconds. Shorten this segment or start an independent motion.')
    }
    return this.job('generate', character.id, character.name, async (job, signal, settings) => {
      job.textEncoder = settings.textEncoder ?? 'llm2vec'
      Object.assign(job, { prompt: batch?.node.prompt ?? request.prompt, seconds: request.seconds, seed: request.seed, steps: request.steps, inPlace: request.inPlace, parentJobId: parent?.id, label: batch?.label, batchId: batch?.id, planNodeId: batch?.nodeId, reusedMotionFrom: batch?.reuseJobId, graphContext: batch?.context })
      this.update(job, 'preflight', 'Checking local rig, ComfyUI nodes, and text-encoder access', 5)
      if (!batch) {
        const checks = await this.check(signal)
        const blockers = checks.filter(c => c.status === 'blocked')
        if (blockers.length) throw new Error(blockers.map(c => `${c.name}: ${c.detail}`).join('\n'))
      }
      signal.throwIfAborted()
      const dir = join(this.root, 'jobs', job.id)
      const python = comfyPythonPath(settings.comfyRoot)
      const kimodo = join(settings.comfyRoot, 'custom_nodes', 'ComfyUI-Kimodo', 'kimodo')
      const processOptions = { signal, log: join(dir, 'backend.log') }
      const motionTool = (command: string, args: string[]) => runProcess(python, [join(this.appRoot, 'backend', 'branch_motion.py'), command, '--kimodo', kimodo, ...args], processOptions)
      const stages: { stage: string; promptId: string; seed: number; fps: number; frames: number }[] = []
      const sample = async (stage: string, sampleRequest: GenerateRequest, constraintsPath = '') => {
        signal.throwIfAborted()
        const prefix = `studio_${job.id.replaceAll('-', '')}_${stage}`
        const result = await generateMotion({
          base: settings.comfyUrl, request: sampleRequest, prefix, signal, constraintsPath, textEncoder: settings.textEncoder,
          submitted: promptId => { job.promptId = promptId; this.persist() },
          progress: (message, p) => this.update(job, p < 30 ? 'queued' : 'generating', `${stage}: ${message}`, p)
        })
        signal.throwIfAborted()
        const files = await readdir(settings.comfyOutput)
        for (const extension of ['npz', 'bvh']) {
          const matches = files.filter(file => file.startsWith(prefix + '_') && file.endsWith('.' + extension))
          if (matches.length !== 1) throw new Error(`Expected one generated ${extension.toUpperCase()} in ${settings.comfyOutput}; found ${matches.length}. Check the configured ComfyUI output folder.`)
          await copyFile(join(settings.comfyOutput, matches[0]), join(dir, `${stage}.${extension}`))
        }
        await motionTool('verify-frames', ['--parent', join(dir, `${stage}.npz`), '--frames', String(result.frames), '--output', join(dir, `${stage}-check.json`)])
        stages.push({ stage, promptId: result.promptId, seed: sampleRequest.seed, fps: result.fps, frames: result.frames })
        return result
      }
      const samplingRequest = { ...request, prompt: graph?.context.effectivePrompt ?? request.prompt }
      let constraintsPath = ''
      let parentMotion = ''
      if (parent) {
        const parentDir = join(this.root, 'jobs', parent.id)
        parentMotion = join(parentDir, parent.parentJobId ? 'sequence.npz' : 'motion.npz')
        if (!batch?.reuseJobId && (!graph || graph.node.kind === 'action')) {
          constraintsPath = join(dir, 'branch-constraints.json')
          this.update(job, 'preflight', 'Conditioning frame zero on the actual parent endpoint', 15)
          await motionTool('condition', ['--parent', parentMotion, '--output', constraintsPath])
        }
      }
      let generated: { promptId?: string; fps: number; frames: number }
      if (batch?.reuseJobId) {
        const source = this.state.jobs.find(j => j.id === batch.reuseJobId && j.stage === 'complete' && j.kind === 'generate')
        if (!source) throw new Error('The completed batch source motion is no longer available.')
        if (source.graphContext?.key !== batch.context.key || source.seed !== request.seed ||
            (parent && (parent.reusedMotionFrom ?? parent.id) !== source.parentJobId))
          throw new Error('Source motion does not match this exact graph path, seed and incoming pose. Refusing cross-context reuse.')
        const sourceDir = join(this.root, 'jobs', source.id)
        const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
        generated = { promptId: manifest.promptId, fps: manifest.report.fps, frames: manifest.clipFrames }
        if (!Number.isInteger(generated.frames) || generated.frames < 2) throw new Error('Source motion manifest is missing its verified node frame count.')
        this.update(job, 'generating', 'Reusing the exact generated source motion for this character', 70)
        for (const name of ['motion', ...(graph?.context.transitionSeconds ? ['transition'] : [])])
          for (const extension of ['npz', 'bvh']) await copyFile(join(sourceDir, `${name}.${extension}`), join(dir, `${name}.${extension}`))
      } else {
        generated = await sample('motion', samplingRequest, constraintsPath)
        if (graph?.node.kind === 'state' && parent) {
          await motionTool('align', ['--parent', parentMotion, '--child', join(dir, 'motion.npz'), '--output', join(dir, 'aligned.npz'), '--fps', String(generated.fps)])
          for (const ext of ['npz', 'bvh']) await copyFile(join(dir, `aligned.${ext}`), join(dir, `motion.${ext}`))
        }
        if (graph?.node.loop) {
          const loopConstraints = join(dir, 'loop-constraints.json')
          await motionTool('condition', ['--parent', join(dir, 'motion.npz'), '--parent-frame', 'first', '--end', join(dir, 'motion.npz'),
            '--frames', String(generated.frames), '--output', loopConstraints])
          const loop = await sample('loop', samplingRequest, loopConstraints)
          if (loop.fps !== generated.fps) throw new Error('Loop generation changed the frame rate.')
          for (const ext of ['npz', 'bvh']) await copyFile(join(dir, `loop.${ext}`), join(dir, `motion.${ext}`))
        }
        if (parent && graph?.context.transitionSeconds) {
          const transitionConstraints = join(dir, 'transition-constraints.json')
          await motionTool('condition', ['--parent', parentMotion, '--end', join(dir, 'motion.npz'),
            '--frames', String(Math.floor(graph.context.transitionSeconds * generated.fps)), '--output', transitionConstraints])
          const transition = await sample('transition', {
            ...request, seconds: graph.context.transitionSeconds, seed: (request.seed + 1) % 4294967296,
            prompt: 'A person smoothly transitions from the supplied initial full-body pose to the supplied final full-body pose, maintaining natural balance'
          }, transitionConstraints)
          if (transition.fps !== generated.fps) throw new Error('Transition and node frame rates differ.')
        }
      }
      if (graph?.node.loop)
        await motionTool('verify-loop', ['--parent', join(dir, 'motion.npz'), '--output', join(dir, 'loop-check.json')])
      let assembledMotion = join(dir, 'motion.npz')
      if (parent) {
        const parentReport = JSON.parse(readFileSync(join(this.root, 'jobs', parent.id, 'animation-report.json'), 'utf8'))
        if (parentReport.fps !== generated.fps) throw new Error('Parent and child motion frame rates differ. Cannot assemble this branch safely.')
        assembledMotion = join(dir, 'sequence.npz')
        this.update(job, 'retargeting', 'Checking branch pose continuity and assembling the complete path', 72)
        let preceding = parentMotion
        if (graph?.context.transitionSeconds) {
          preceding = join(dir, 'approach.npz')
          await motionTool('stitch', ['--parent', parentMotion, '--child', join(dir, 'transition.npz'), '--output', preceding, '--fps', String(generated.fps)])
        }
        await motionTool('stitch', ['--parent', preceding, '--child', join(dir, 'motion.npz'), '--output', assembledMotion, '--fps', String(generated.fps)])
      }
      this.update(job, 'retargeting', 'Reading original SOMA motion and rest-pose data', 75)
      await runProcess(python, [
        join(this.appRoot, 'backend', 'prepare_motion.py'),
        '--kimodo', kimodo,
        '--input', assembledMotion, '--output', join(dir, 'motion.json'), '--fps', String(generated.fps)
      ], { signal, log: join(dir, 'backend.log') })
      await this.blender(job, { command: 'animate', input: join(character.rigDirectory!, 'rigged.blend'), motion: join(dir, 'motion.json'), output: dir, inPlace: request.inPlace }, signal, settings)
      signal.throwIfAborted()
      const report = JSON.parse(readFileSync(join(dir, 'animation-report.json'), 'utf8'))
      await validateCharacterGlb(join(dir, 'animated.glb'), true)
      if (report.weightedVertices !== report.vertices || report.frames < 2 || report.sampledMeshDisplacement <= 0.00001)
        throw new Error('Character output did not pass skin/animation validation.')
      job.outputFiles = ['animated.glb', 'animated.fbx', 'animated.blend', 'motion.bvh', 'motion.npz']
      if (parent) job.outputFiles.push('sequence.bvh', 'sequence.npz')
      if (graph) {
        for (const prefix of ['clip', ...(graph.context.transitionSeconds ? ['transition'] : [])]) {
          const input = join(dir, prefix === 'clip' ? 'motion.npz' : 'transition.npz')
          const motion = join(dir, `${prefix}-motion.json`)
          await runProcess(python, [join(this.appRoot, 'backend', 'prepare_motion.py'), '--kimodo', kimodo, '--input', input, '--output', motion, '--fps', String(generated.fps), '--origin', assembledMotion], processOptions)
          await this.blender(job, { command: 'animate', input: join(character.rigDirectory!, 'rigged.blend'), motion, output: dir, inPlace: request.inPlace, exportPrefix: prefix, allowStatic: prefix === 'transition' }, signal, settings)
          await validateCharacterGlb(join(dir, `${prefix}.glb`), true)
          job.outputFiles.push(`${prefix}.glb`, `${prefix}.fbx`, `${prefix}.blend`)
          if (prefix === 'transition') job.outputFiles.push('transition.npz', 'transition.bvh')
        }
        job.clipPreviewUrl = this.asset(`${job.id}-clip`, join(dir, 'clip.glb'))
        if (graph.context.transitionSeconds) job.transitionPreviewUrl = this.asset(`${job.id}-transition`, join(dir, 'transition.glb'))
      }
      for (const file of job.outputFiles) if ((await stat(join(dir, file))).size < 50) throw new Error(`Generated output is empty: ${file}`)
      job.previewUrl = this.asset(`${job.id}-output`, join(dir, 'animated.glb'))
      job.warnings = [...report.warnings, ...(settings.textEncoder === 'lfm' ? ['Experimental LFM text conditioning: inspect handedness, stance and motion details before production use.'] : []),
        ...(graph?.node.loop ? ['Loop endpoint poses were checked; review velocity continuity and foot contact before production use.'] : [])]
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ request, samplingRequest, graph: batch ? { node: batch.node, context: batch.context } : undefined,
        textEncoder: job.textEncoder, stages, promptId: generated.promptId, clipFrames: generated.frames, reusedMotionFrom: batch?.reuseJobId, source: character.name, setup: character.setup, report }, null, 2))
    }, !!batch)
  }

  async cancel() {
    this.batchController?.abort()
    const active = this.active
    if (!active) return
    active.controller.abort()
    this.update(active.job, active.job.stage, 'Cancelling this job only...', active.job.progress)
    // The job catch path cancels after an in-flight submission finishes as well.
    if (active.job.promptId) await cancelMotion(active.settings.comfyUrl, active.job.promptId)
  }

  savePlan(value: MotionPlan): MotionPlan {
    const plan = planSchema.parse(value)
    const index = this.state.plans.findIndex(p => p.id === plan.id)
    if (index < 0) this.state.plans.unshift(plan)
    else this.state.plans[index] = plan
    this.persist()
    return structuredClone(plan)
  }

  plan(id: string): MotionPlan {
    const plan = this.state.plans.find(p => p.id === id)
    if (!plan) throw new Error('Saved motion configuration not found.')
    return structuredClone(plan)
  }

  private activeJobId(): string | undefined { return this.active?.job.id }

  async runBatch(value: BatchRequest, savedPlan?: MotionPlan): Promise<void> {
    if (this.designerBusy || this.active || this.batchController) throw new Error('Wait for the current job or batch to finish.')
    const request = batchSchema.parse(value)
    const plan = planSchema.parse(savedPlan ?? this.plan(request.planId))
    const batch: Batch = {
      id: randomUUID(), name: plan.name, createdAt: new Date().toISOString(), status: 'running',
      plan: structuredClone(plan), request: structuredClone(request),
      textEncoder: this.state.settings.textEncoder ?? 'llm2vec',
      items: createBatchItems(plan, request, this.state.characters, randomUUID)
    }
    this.state.batches.unshift(batch)
    const controller = new AbortController()
    this.batchController = controller
    this.persist()
    try {
      const checks = await this.check(controller.signal)
      controller.signal.throwIfAborted()
      const blocked = checks.filter(c => c.status === 'blocked')
      if (blocked.length) throw new Error(blocked.map(c => `${c.name}: ${c.detail}`).join('\n'))
      for (const item of batch.items) {
        controller.signal.throwIfAborted()
        const node = plan.nodes.find(n => n.id === item.nodeId)!
        const parent = item.parentItemId ? batch.items.find(i => i.id === item.parentItemId) : undefined
        if (parent && parent.status !== 'complete') {
          item.status = 'blocked'; item.message = 'Parent motion failed; no unrelated replacement was generated.'; this.persist(); continue
        }
        item.status = 'running'
        this.persist()
        try {
          const character = this.character(item.characterId)
          if (!character.rigged) {
            if (!request.autoRig) throw new Error('Character needs a rig. Fit it first or enable the saved-fit batch option.')
            character.setup = setupSchema.parse({ ...plan.rigSetup, rotation: character.setup.rotation })
            await this.rig(character.id, true)
          }
          const reusable = batch.items.find(i => i.status === 'complete' && i.context?.key === item.context!.key && i.seed === item.seed)
          const generation = this.generate({
            characterId: item.characterId, prompt: node.legacySegments ? node.prompt : node.prompt.replace(/\./g, ','), seconds: node.seconds,
            seed: item.seed, steps: node.steps, inPlace: node.inPlace, parentJobId: parent?.jobId
          }, { id: batch.id, nodeId: node.id, label: item.context!.pathLabel, reuseJobId: reusable?.jobId, node, context: item.context! })
          item.jobId = this.activeJobId()
          this.persist()
          const job = await generation
          item.jobId = job.id
          item.status = 'complete'; item.message = 'Animated character exported.'
        } catch (error) {
          item.status = controller.signal.aborted ? 'cancelled' : 'failed'
          item.message = errorText(error)
        }
        this.persist()
      }
      batch.status = batch.items.every(item => item.status === 'complete') ? 'complete' : 'failed'
    } catch (error) {
      batch.status = controller.signal.aborted ? 'cancelled' : 'failed'
      for (const item of batch.items) if (item.status === 'pending' || item.status === 'running') {
        item.status = controller.signal.aborted ? 'cancelled' : 'blocked'; item.message = errorText(error)
      }
      throw new Error(controller.signal.aborted ? 'Batch cancelled. Completed outputs are preserved.' : errorText(error))
    } finally {
      if (controller.signal.aborted) batch.status = 'cancelled'
      this.batchController = undefined
      this.persist()
    }
  }

  async rerunBatch(id: string) {
    const batch = this.state.batches.find(b => b.id === id)
    if (!batch) throw new Error('Saved batch not found.')
    if ((batch.textEncoder ?? 'llm2vec') !== (this.state.settings.textEncoder ?? 'llm2vec'))
      throw new Error(`Select this batch's original ${batch.textEncoder === 'lfm' ? 'LFM bridge' : 'Llama + LLM2Vec'} encoder in Backend connections before rerunning. Encoder changes would alter its saved motion conditioning.`)
    return this.runBatch(batch.request, batch.plan)
  }

  async exportBatch(id: string, destination: string): Promise<string> {
    const current = this.state.batches.find(b => b.id === id)
    if (!current) throw new Error('Batch not found.')
    const batch = structuredClone(current)
    const completed = batch.items.filter(i => i.status === 'complete' && i.jobId)
    if (!completed.length) throw new Error('This batch has no completed character outputs to export.')
    const target = join(destination, `KimodoBatch-${batch.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`)
    mkdirSync(target)
    for (const item of completed) {
      const safeName = (item.characterName.replace(/\.fbx$/i, '') + '-' + (item.context?.pathLabel ?? item.label)).replace(/[^a-zA-Z0-9 _-]/g, '_').slice(0, 100)
      const directory = join(target, `${safeName}-seed${item.seed}-${item.id.slice(0, 8)}`)
      mkdirSync(directory)
      const job = this.state.jobs.find(j => j.id === item.jobId)!
      for (const file of job.outputFiles ?? []) await copyFile(this.output(job.id, file), join(directory, file))
      await copyFile(join(this.root, 'jobs', job.id, 'manifest.json'), join(directory, 'manifest.json'))
    }
    await writeFile(join(target, 'batch.json'), JSON.stringify(batch, null, 2))
    return target
  }

  async check(signal?: AbortSignal): Promise<Check[]> {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    const settings = this.state.settings
    const [blender, python, comfy] = await Promise.all([
      runProcess(settings.blenderPath, ['--background', '--factory-startup', '--version'], { signal, timeout: 30_000 })
        .then<Check>(out => ({ name: 'Blender rigging backend', status: 'ready', detail: out.split(/\r?\n/).find(s => s.startsWith('Blender')) ?? 'Blender is available' }))
        .catch((e): Check => ({ name: 'Blender rigging backend', status: 'blocked', detail: `Native Blender cannot start. Run npm run setup:blender or choose the native Blender executable in Settings. ${errorText(e)}` })),
      runProcess(comfyPythonPath(settings.comfyRoot), [join(this.appRoot, 'backend', 'preflight.py'), '--encoder', settings.textEncoder ?? 'llm2vec'], { signal, timeout: 90_000 })
        .then<Check[]>(out => {
          const line = out.split(/\r?\n/).find(s => s.startsWith('STUDIO_CHECKS:'))
          if (!line) throw new Error('Environment probe returned no checks.')
          return JSON.parse(line.slice(14))
        }).catch((e): Check[] => [{ name: 'Comfy Python / model access', status: 'blocked', detail: errorText(e) }]),
      api<Record<string, unknown>>(settings.comfyUrl, '/object_info', undefined, signal)
        .then<Check>(info => {
          const loader = settings.textEncoder === 'lfm' ? 'Studio_Kimodo_LoadLFM' : 'Kimodo_LoadModel'
          const missing = [loader, 'Kimodo_TextEncode', 'Kimodo_Sampler', 'Kimodo_SaveNPZ', 'Kimodo_ExportBVH', 'Kimodo_Preview3D'].filter(n => !(n in info))
          return { name: 'ComfyUI / Kimodo nodes', status: missing.length ? 'blocked' : 'ready', detail: missing.length ? 'Missing nodes: ' + missing.join(', ') + (settings.textEncoder === 'lfm' ? '. Run scripts\\setup-lfm.ps1 for this backend, then restart ComfyUI.' : '') : `Connected to ${settings.comfyUrl}; all required nodes registered.` }
        }).catch((e): Check => ({ name: 'ComfyUI / Kimodo nodes', status: 'blocked', detail: `Cannot connect to ${settings.comfyUrl}. Start the local backend, or change its port in Settings. ${errorText(e)}` }))
    ])
    let output: Check
    try {
      await access(settings.comfyOutput)
      output = { name: 'Local output folder', status: 'ready', detail: settings.comfyOutput }
    } catch {
      output = { name: 'Local output folder', status: 'blocked', detail: `Folder is unavailable: ${settings.comfyOutput}. Choose ComfyUI's actual output folder.` }
    }
    return [blender, comfy, ...python, output]
  }

  async startComfy() {
    if (this.designerBusy) throw new Error('Wait for Designer generation before starting a backend.')
    if (this.startingComfy) throw new Error('ComfyUI is already starting.')
    const settings = this.state.settings
    try { await api(settings.comfyUrl, '/system_stats'); return } catch { /* Start is explicitly requested when the service is offline. */ }
    if (this.managedComfy && this.managedComfy.exitCode === null) throw new Error('The app-owned backend is still starting. Wait and refresh checks.')
    this.startingComfy = true
    const log = createWriteStream(join(this.root, 'comfy-server.log'), { flags: 'a' })
    try {
      const child = spawn(comfyPythonPath(settings.comfyRoot), [
        '-u', join(settings.comfyRoot, 'main.py'), '--listen', '127.0.0.1',
        '--port', new URL(settings.comfyUrl).port || '80', '--disable-auto-launch'
      ], {
        cwd: settings.comfyRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TEXT_ENCODER_MODE: 'local', TEXT_ENCODER: 'llm2vec', PYTHONUNBUFFERED: '1' }
      })
      this.managedComfy = child
      let failure: Error | undefined
      child.on('error', error => { failure = error })
      child.stdout.pipe(log, { end: false })
      child.stderr.pipe(log, { end: false })
      child.on('close', () => { log.end(); if (this.managedComfy === child) this.managedComfy = undefined })
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        if (failure) throw failure
        if (child.exitCode !== null) throw new Error(`ComfyUI exited with code ${child.exitCode}. See comfy-server.log in app data.`)
        try { await api(settings.comfyUrl, '/system_stats'); return } catch { await delay(2000) }
      }
      throw new Error('ComfyUI is still starting after three minutes. Inspect comfy-server.log and refresh checks.')
    } finally { this.startingComfy = false }
  }

  output(jobId: string, file: string): string {
    const job = this.state.jobs.find(j => j.id === jobId)
    if (!job || job.stage !== 'complete' || job.kind !== 'generate' || !job.outputFiles?.includes(file))
      throw new Error('This is not a validated completed output.')
    return join(this.root, 'jobs', jobId, file)
  }

  async dispose() {
    this.lifetime.abort()
    try { await Promise.all([this.cancel(), this.designer.cancel()]) }
    finally { this.managedComfy?.kill() }
  }
}
