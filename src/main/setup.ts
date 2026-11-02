import { existsSync, readFileSync, statSync } from 'node:fs'
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { arch, homedir, platform, release, totalmem } from 'node:os'
import { basename, join, sep } from 'node:path'
import { z } from 'zod'
import type { DesignerConfig } from '../shared/designer'
import type { Settings } from '../shared/types'
import {
  formatBytes, launchIssues, modelUrl, setupLinks, setupModel, setupModels, summarizeSetup,
  type LaunchCheck, type SetupActionId, type SetupItem, type SetupItemId, type SetupModel, type SetupReport, type SetupState, type SetupTask
} from '../shared/setup'
import { api } from './comfy'
import { downloadVerified, ensureSpace, freeBytes } from './download'
import { blenderDistribution, comfyPythonPath, defaultComfyRoot } from './native-runtime'
import { runProcess } from './process'
import { errorText } from './validation'

export interface SetupHost {
  root: string
  appRoot: string
  firstLaunch: boolean
  /** Suppresses launch-time prompts (used by automated smoke checks). */
  quietLaunch?: boolean
  settings(): Settings
  saveSettings(value: Settings): Settings
  startComfy(): Promise<void>
  designerConfig(): DesignerConfig
  saveDesignerConfig(value: DesignerConfig): void
  choose(kind: 'blender' | 'comfy' | 'output'): Promise<string | null>
  openExternal(url: string): Promise<void>
  notify(state: SetupState): void
  signal?: AbortSignal
}

interface StoredSetup {
  showOnLaunch: boolean
  completedAt?: string
  checkOnLaunch?: boolean
  ignoredAtLaunch?: SetupItemId[]
  llama?: { status: 'ready' | 'warning' | 'blocked'; detail: string; checkedAt: string }
}
const itemIdSchema = z.string().regex(/^(system|blender|comfy-install|comfy-output|comfy-running|kimodo-nodes|text-encoder|ollama|model:[a-z0-9-]{1,40})$/)
  .transform(value => value as SetupItemId)
const storedSchema = z.object({
  showOnLaunch: z.boolean(), completedAt: z.string().optional(),
  checkOnLaunch: z.boolean().optional(), ignoredAtLaunch: z.array(itemIdSchema).max(32).optional(),
  llama: z.object({ status: z.enum(['ready', 'warning', 'blocked']), detail: z.string(), checkedAt: z.string() }).optional()
})
export const setupRunSchema = z.object({
  item: z.string().max(64),
  action: z.enum(['install-blender', 'browse-blender', 'detect-comfy', 'browse-comfy', 'open-comfy-guide', 'use-default-output', 'browse-output',
    'start-comfy', 'open-kimodo-nodes', 'install-lfm', 'verify-llama', 'open-llama-access', 'download-model', 'open-model-license', 'open-ollama']),
  model: z.string().max(64).optional()
}).strict()
export const setupPreferencesSchema = z.object({
  showOnLaunch: z.boolean().optional(), completed: z.boolean().optional(), checkOnLaunch: z.boolean().optional(),
  ignoredAtLaunch: z.array(itemIdSchema).max(32).optional()
}).strict()
export type SetupPreferences = z.input<typeof setupPreferencesSchema>

const kimodoNodes = ['Kimodo_TextEncode', 'Kimodo_Sampler', 'Kimodo_SaveNPZ', 'Kimodo_ExportBVH', 'Kimodo_Preview3D']
// ComfyUI loader node and input that list each model folder.
const folderLoaders: Record<string, [string, string][]> = {
  checkpoints: [['CheckpointLoaderSimple', 'ckpt_name'], ['ImageOnlyCheckpointLoader', 'ckpt_name']],
  diffusion_models: [['UNETLoader', 'unet_name']],
  text_encoders: [['CLIPLoader', 'clip_name']],
  vae: [['VAELoader', 'vae_name']],
  background_removal: [['LoadBackgroundRemovalModel', 'bg_removal_name']]
}
type NodeCatalog = Record<string, { input?: { required?: Record<string, unknown[]> } }>

/** Replaces the home directory so paths shown in the checklist and screenshots do not reveal the account name. */
export function displayPath(path: string, home = homedir()): string {
  return home && path.toLowerCase().startsWith(home.toLowerCase() + sep.toLowerCase()) ? '~' + path.slice(home.length) : path
}

export function isComfyInstall(root: string, os: string = process.platform): boolean {
  return !!root && existsSync(join(root, 'main.py')) && existsSync(comfyPythonPath(root, os))
}

export function comfyCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir(), os: string = process.platform): string[] {
  const list = [defaultComfyRoot(os, env, home), join(home, 'Documents', 'ComfyUI'), join(home, 'ComfyUI')]
  if (os === 'win32') list.push('C:\\ComfyUI')
  return [...new Set(list)]
}

export function loaderChoices(nodes: NodeCatalog, folder: string): string[] {
  const names = new Set<string>()
  for (const [node, field] of folderLoaders[folder] ?? []) {
    const spec = nodes[node]?.input?.required?.[field]
    const combo = spec?.[1]
    const options = Array.isArray(spec?.[0]) ? spec[0] : combo && typeof combo === 'object' && 'options' in combo ? (combo as { options: unknown }).options : undefined
    if (Array.isArray(options)) for (const name of options) if (typeof name === 'string') names.add(name)
  }
  return [...names]
}

export function modelPath(comfyRoot: string, model: SetupModel) {
  return join(comfyRoot, 'models', model.folder, model.file)
}

/** Status of one pinned Designer model: the exact file on disk, or an equivalent model ComfyUI already lists and Designer uses. */
export async function modelItem(model: SetupModel, comfyRoot: string, installed: string[] | undefined, config: DesignerConfig, comfyReady: boolean): Promise<SetupItem> {
  const item: SetupItem = {
    id: `model:${model.id}`, group: 'designer', title: model.label, requiredFor: ['designer'], bytes: model.bytes,
    status: 'todo', detail: `${model.purpose} ${formatBytes(model.bytes)} · ${model.license}.`,
    actions: [
      { id: 'download-model', label: `Download ${formatBytes(model.bytes)}`, primary: true, model: model.id, disabled: comfyReady ? undefined : 'Choose a ComfyUI folder first.' },
      { id: 'open-model-license', label: 'License', model: model.id }
    ]
  }
  const size = await stat(modelPath(comfyRoot, model)).then(s => s.size, () => undefined)
  const selected = config[model.configField]
  const listed = installed?.some(name => basename(name.replaceAll('\\', '/')) === model.file)
  if (size === model.bytes || (listed && size === undefined)) {
    return { ...item, status: 'done', detail: `${model.purpose} Installed${size === undefined ? ' (listed by ComfyUI)' : ''}.`, actions: [{ id: 'open-model-license', label: 'License', model: model.id }] }
  }
  if (size !== undefined) return { ...item, status: 'warning', detail: `${model.file} exists but differs from the pinned ${formatBytes(model.bytes)} release. Download to replace it, or select your own weights in Designer model settings.` }
  if (typeof selected === 'string' && selected && installed?.includes(selected) && basename(selected.replaceAll('\\', '/')) !== model.file)
    return { ...item, status: 'done', detail: `${model.purpose} Designer already uses ${selected}.`, actions: [{ id: 'open-model-license', label: 'License', model: model.id }] }
  return item
}

export class SetupAssistant {
  private stored: StoredSetup
  private task?: SetupTask
  private controller?: AbortController
  private launchController?: AbortController
  private result?: SetupState['result']
  private readonly file: string

  constructor(private host: SetupHost) {
    this.file = join(host.root, 'setup.json')
    let stored: StoredSetup | undefined
    try { stored = existsSync(this.file) ? storedSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) : undefined } catch { stored = undefined }
    // Existing installations are not interrupted by the checklist; it can still be opened from the top bar.
    this.stored = stored ?? { showOnLaunch: host.firstLaunch }
  }

  state(): SetupState {
    return structuredClone({
      firstLaunch: this.host.firstLaunch, showOnLaunch: this.stored.showOnLaunch, completedAt: this.stored.completedAt,
      checkOnLaunch: !this.host.quietLaunch && (this.stored.checkOnLaunch ?? true), ignoredAtLaunch: this.stored.ignoredAtLaunch ?? [], task: this.task, result: this.result
    })
  }

  private async save() {
    await writeFile(this.file + '.tmp', JSON.stringify(this.stored, null, 2))
    await rename(this.file + '.tmp', this.file)
  }

  async preferences(value: SetupPreferences): Promise<SetupState> {
    const update = setupPreferencesSchema.parse(value)
    if (update.showOnLaunch !== undefined) this.stored.showOnLaunch = update.showOnLaunch
    if (update.checkOnLaunch !== undefined) this.stored.checkOnLaunch = update.checkOnLaunch
    if (update.ignoredAtLaunch) this.stored.ignoredAtLaunch = [...new Set(update.ignoredAtLaunch)]
    if (update.completed) this.stored.completedAt = new Date().toISOString()
    await this.save()
    return this.state()
  }

  /**
   * Validates dependencies on a later launch. Cancelling resolves immediately with `cancelled` and stops pending probes.
   * Ignored items that work again are forgotten, so a later failure is reported again.
   */
  async launchCheck(): Promise<LaunchCheck> {
    this.launchController?.abort()
    const controller = new AbortController()
    this.launchController = controller
    const cancelled = new Promise<LaunchCheck>(resolve => controller.signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }))
    try {
      return await Promise.race([cancelled, this.report(controller.signal).then(async (report): Promise<LaunchCheck> => {
        if (controller.signal.aborted) return { cancelled: true }
        const ignored = this.stored.ignoredAtLaunch ?? []
        const still = ignored.filter(id => report.items.find(item => item.id === id)?.status !== 'done')
        if (still.length !== ignored.length) { this.stored.ignoredAtLaunch = still; await this.save() }
        return { cancelled: false, report, issues: launchIssues(report.items, still) }
      }, (error): LaunchCheck | Promise<never> => controller.signal.aborted ? { cancelled: true } : Promise.reject(error))])
    } finally {
      if (this.launchController === controller) this.launchController = undefined
    }
  }

  cancelLaunchCheck() { this.launchController?.abort() }

  async report(cancel?: AbortSignal): Promise<SetupReport> {
    const settings = this.host.settings()
    const signals = [this.host.signal, cancel].filter((s): s is AbortSignal => !!s)
    const signal = signals.length ? AbortSignal.any(signals) : undefined
    const os = process.platform
    const comfyInstalled = isComfyInstall(settings.comfyRoot)
    const [blender, stats, nodes, ollama, outputExists] = await Promise.all([
      runProcess(settings.blenderPath, ['--background', '--factory-startup', '--version'], { signal, timeout: 30_000 })
        .then(out => ({ ok: true, detail: out.split(/\r?\n/).find(s => s.startsWith('Blender')) ?? 'Blender is available' }), error => ({ ok: false, detail: errorText(error) })),
      api<{ devices: { name: string; type: string; vram_total: number; vram_free: number }[] }>(settings.comfyUrl, '/system_stats', undefined, signal).catch(() => undefined),
      api<NodeCatalog>(settings.comfyUrl, '/object_info', undefined, signal).catch(() => undefined),
      fetch('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(3000), ...signals]) })
        .then(r => r.ok ? r.json() as Promise<{ models?: { name: string }[] }> : undefined).catch(() => undefined),
      access(settings.comfyOutput).then(() => true, () => false)
    ])
    const running = !!stats
    const items: SetupItem[] = []

    const diskRoot = comfyInstalled ? settings.comfyRoot : this.host.root
    const free = await freeBytes(diskRoot).catch(() => undefined)
    const gpus = stats?.devices.filter(d => d.type !== 'cpu') ?? []
    const remaining = setupModels.reduce((sum, model) => sum + model.bytes, 0)
    items.push({
      id: 'system', group: 'core', title: 'This PC', requiredFor: [],
      status: free !== undefined && free < remaining + 10 * 1024 ** 3 ? 'warning' : 'done',
      detail: [`${os === 'win32' ? 'Windows' : os === 'darwin' ? 'macOS' : 'Linux'} ${release()} · ${arch()} · ${formatBytes(totalmem())} RAM`,
        free !== undefined ? `${formatBytes(free)} free on the ${comfyInstalled ? 'ComfyUI' : 'app data'} drive` : 'Free disk space unavailable',
        gpus.length ? gpus.map(g => `${g.name.replace(/^cuda:\d+\s*/, '')} (${(g.vram_total / 2 ** 30).toFixed(1)} GiB)`).join(', ') : running ? 'No GPU reported by ComfyUI; image and 3D generation require a GPU' : 'GPU is reported once ComfyUI runs'
      ].join(' · ') + (free !== undefined && free < remaining + 10 * 1024 ** 3 ? `. All Designer models need about ${formatBytes(remaining)}; free space before downloading.` : '.'),
      actions: []
    })

    let distribution: ReturnType<typeof blenderDistribution> | undefined
    try { distribution = blenderDistribution() } catch { distribution = undefined }
    items.push({
      id: 'blender', group: 'core', title: 'Blender (rigging & export)', requiredFor: ['animator'],
      status: blender.ok ? 'done' : 'todo',
      detail: blender.ok ? `${blender.detail} · ${displayPath(settings.blenderPath)}` :
        `Native Blender is needed to fit, skin and export characters. Studio installs an isolated, checksum-verified copy that never touches ComfyUI.`,
      actions: blender.ok ? [{ id: 'browse-blender', label: 'Change' }] : [
        { id: 'install-blender', label: distribution ? `Install Blender ${distribution.directory.split('-')[1]}` : 'Install Blender', primary: true, disabled: distribution ? undefined : 'No official build is pinned for this platform.' },
        { id: 'browse-blender', label: 'Choose existing' }
      ]
    })

    const found = comfyInstalled ? undefined : comfyCandidates().find(path => isComfyInstall(path))
    items.push({
      id: 'comfy-install', group: 'core', title: 'ComfyUI folder', requiredFor: ['designer', 'animator'],
      status: comfyInstalled ? 'done' : 'todo',
      detail: comfyInstalled ? displayPath(settings.comfyRoot) : found ? `Found a ComfyUI installation at ${displayPath(found)}.` :
        `No ComfyUI with main.py and a venv was found at ${displayPath(settings.comfyRoot)}. Install ComfyUI (manual install with a venv folder), then choose its folder. Studio reuses your GPU environment and never reinstalls it.`,
      actions: comfyInstalled ? [{ id: 'browse-comfy', label: 'Change' }] : [
        ...(found ? [{ id: 'detect-comfy' as const, label: 'Use this folder', primary: true }] : []),
        { id: 'browse-comfy', label: 'Choose folder', primary: !found },
        { id: 'open-comfy-guide', label: 'Install guide' }
      ]
    })

    items.push({
      id: 'comfy-output', group: 'core', title: 'ComfyUI output folder', requiredFor: ['designer', 'animator'],
      status: outputExists ? 'done' : 'todo',
      detail: outputExists ? displayPath(settings.comfyOutput) : `Unavailable: ${displayPath(settings.comfyOutput)}. Studio reads generated motion and images from ComfyUI's output folder.`,
      actions: outputExists ? [{ id: 'browse-output', label: 'Change' }] : [
        { id: 'use-default-output', label: 'Use ComfyUI/output', primary: true, disabled: comfyInstalled ? undefined : 'Choose a ComfyUI folder first.' },
        { id: 'browse-output', label: 'Choose folder' }
      ]
    })

    items.push({
      id: 'comfy-running', group: 'core', title: 'Local ComfyUI service', requiredFor: ['designer', 'animator'],
      status: running ? 'done' : 'todo',
      detail: running ? `Connected to ${settings.comfyUrl}.` : `Not reachable at ${settings.comfyUrl}. Studio can start it on this PC (loopback only) and stops it again when Studio closes.`,
      actions: running ? [] : [{ id: 'start-comfy', label: 'Start ComfyUI', primary: true, disabled: comfyInstalled ? undefined : 'Choose a ComfyUI folder first.' }]
    })

    const kimodoOnDisk = existsSync(join(settings.comfyRoot, 'custom_nodes', 'ComfyUI-Kimodo', 'nodes.py'))
    const missing = nodes ? [...kimodoNodes, 'Kimodo_LoadModel'].filter(n => !(n in nodes)) : []
    items.push({
      id: 'kimodo-nodes', group: 'animator', title: 'Kimodo motion nodes', requiredFor: ['animator'],
      status: nodes ? missing.length ? 'todo' : 'done' : kimodoOnDisk ? 'warning' : 'todo',
      detail: nodes ? missing.length ? `ComfyUI is missing ${missing.join(', ')}. Install ComfyUI-Kimodo into custom_nodes with its requirements, then restart ComfyUI.` : 'All Kimodo nodes are registered in ComfyUI.' :
        kimodoOnDisk ? 'ComfyUI-Kimodo is in custom_nodes. Start ComfyUI to confirm the nodes load.' :
          'Install ComfyUI-Kimodo into ComfyUI/custom_nodes following its README. Studio does not modify ComfyUI\'s Python packages.',
      actions: nodes && !missing.length ? [] : [{ id: 'open-kimodo-nodes', label: 'Open ComfyUI-Kimodo', primary: !kimodoOnDisk }]
    })

    const lfmOnDisk = existsSync(join(settings.comfyRoot, 'custom_nodes', 'studio_kimodo_lfm', '__init__.py'))
    const lfmBlocked = !comfyInstalled ? 'Choose a ComfyUI folder first.' : !kimodoOnDisk ? 'Install ComfyUI-Kimodo first.' : undefined
    if (settings.textEncoder === 'lfm') {
      const registered = !!nodes && 'Studio_Kimodo_LoadLFM' in nodes
      items.push({
        id: 'text-encoder', group: 'animator', title: 'Text encoder: LFM bridge', requiredFor: ['animator'],
        status: registered ? 'done' : lfmOnDisk ? 'warning' : 'todo',
        detail: registered ? 'Experimental LFM bridge is installed and registered. No Llama approval or login is needed.' :
          lfmOnDisk ? 'LFM bridge is installed. Restart ComfyUI so it registers Studio_Kimodo_LoadLFM.' :
            'Downloads about 0.8 GB of pinned, ungated weights into the ComfyUI environment and installs Studio\'s scoped LFM node.',
        actions: registered ? [] : [{ id: 'install-lfm', label: lfmOnDisk ? 'Reinstall LFM bridge' : 'Install LFM bridge', primary: !lfmOnDisk, disabled: lfmBlocked }]
      })
    } else {
      const llama = this.stored.llama
      const ok = llama && llama.status !== 'blocked'
      items.push({
        id: 'text-encoder', group: 'animator', title: 'Text encoder: Llama + LLM2Vec', requiredFor: ['animator'],
        status: ok ? 'done' : 'todo',
        detail: llama ? llama.detail : 'The original encoder needs approved access to the gated Meta Llama 3 model and a Hugging Face login inside the ComfyUI environment (hf auth login). Studio never asks for your token. Or switch to the experimental LFM bridge, which needs no approval.',
        actions: [
          { id: 'verify-llama', label: llama ? 'Check again' : 'Check access', primary: !ok, disabled: comfyInstalled ? undefined : 'Choose a ComfyUI folder first.' },
          ...(ok ? [] : [{ id: 'open-llama-access' as const, label: 'Request access' }, { id: 'install-lfm' as const, label: 'Use LFM bridge instead', disabled: lfmBlocked }])
        ]
      })
    }

    const config = this.host.designerConfig()
    for (const model of setupModels)
      items.push(await modelItem(model, settings.comfyRoot, nodes ? loaderChoices(nodes, model.folder) : undefined, config, comfyInstalled))

    const titleModels = ollama?.models?.filter(m => !/cloud/i.test(m.name)) ?? []
    items.push({
      id: 'ollama', group: 'optional', title: 'Ollama (automatic character names)', requiredFor: [],
      status: titleModels.length ? 'done' : 'optional',
      detail: titleModels.length ? `${titleModels.length} local model${titleModels.length === 1 ? '' : 's'} available for naming.` :
        ollama ? 'Ollama is running without a local model. Pull a small model (for example ollama pull llama3.2) or type titles yourself.' :
          'Optional. Without Ollama, give each design a title yourself.',
      actions: titleModels.length ? [] : [{ id: 'open-ollama', label: 'Get Ollama' }]
    })
    return { items, ready: summarizeSetup(items), checkedAt: new Date().toISOString() }
  }

  cancel() { this.controller?.abort() }

  private progress(message: string, fraction?: number) {
    if (!this.task) return
    this.task = { ...this.task, message, fraction }
    this.host.notify(this.state())
  }

  async run(value: { item: string; action: SetupActionId; model?: string }): Promise<SetupState> {
    const request = setupRunSchema.parse(value)
    const links: Partial<Record<SetupActionId, string>> = {
      'open-comfy-guide': setupLinks.comfyGuide, 'open-kimodo-nodes': setupLinks.kimodoNodes,
      'open-llama-access': setupLinks.llamaAccess, 'open-ollama': setupLinks.ollama
    }
    if (links[request.action]) { await this.host.openExternal(links[request.action]!); return this.state() }
    if (request.action === 'open-model-license') { await this.host.openExternal(setupModel(request.model ?? '').licenseUrl); return this.state() }
    if (this.task) throw new Error(`Wait for “${this.task.label}” to finish or cancel it.`)
    const item = request.item as SetupItemId
    this.controller = new AbortController()
    const signal = this.host.signal ? AbortSignal.any([this.controller.signal, this.host.signal]) : this.controller.signal
    this.task = { item, action: request.action, label: labelFor(request.action, request.model), message: 'Starting…' }
    this.result = undefined
    this.host.notify(this.state())
    try {
      const message = await this.perform(request.action, request.model, signal)
      this.result = { item, ok: true, message }
    } catch (error) {
      this.result = { item, ok: false, message: signal.aborted ? `${this.task.label} was cancelled. Partial downloads were removed.` : errorText(error) }
    } finally {
      this.task = undefined
      this.controller = undefined
      this.host.notify(this.state())
    }
    return this.state()
  }

  private updateSettings(change: Partial<Settings>) {
    return this.host.saveSettings({ ...this.host.settings(), ...change })
  }

  private async perform(action: SetupActionId, modelId: string | undefined, signal: AbortSignal): Promise<string> {
    const settings = this.host.settings()
    switch (action) {
      case 'install-blender': return this.installBlender(signal)
      case 'browse-blender': {
        const path = await this.host.choose('blender')
        if (!path) return 'No Blender executable was chosen.'
        await runProcess(path, ['--background', '--factory-startup', '--version'], { signal, timeout: 30_000 })
        this.updateSettings({ blenderPath: path })
        return 'Blender verified and saved.'
      }
      case 'detect-comfy': {
        const found = comfyCandidates().find(path => isComfyInstall(path))
        if (!found) throw new Error('No ComfyUI installation with main.py and a venv was found in the usual locations. Choose its folder instead.')
        return this.useComfy(found)
      }
      case 'browse-comfy': {
        const path = await this.host.choose('comfy')
        if (!path) return 'No ComfyUI folder was chosen.'
        if (!isComfyInstall(path)) throw new Error(`That folder needs main.py and ${process.platform === 'win32' ? 'venv\\Scripts\\python.exe' : 'venv/bin/python'}. Choose the ComfyUI folder that contains them.`)
        return this.useComfy(path)
      }
      case 'use-default-output': {
        if (!isComfyInstall(settings.comfyRoot)) throw new Error('Choose a ComfyUI folder first.')
        const output = join(settings.comfyRoot, 'output')
        await mkdir(output, { recursive: true })
        this.updateSettings({ comfyOutput: output })
        return 'ComfyUI output folder saved.'
      }
      case 'browse-output': {
        const path = await this.host.choose('output')
        if (!path) return 'No output folder was chosen.'
        this.updateSettings({ comfyOutput: path })
        return 'Output folder saved.'
      }
      case 'start-comfy': {
        this.progress('Starting local ComfyUI. The first start can take a few minutes.')
        await this.host.startComfy()
        return 'Local ComfyUI is running.'
      }
      case 'install-lfm': {
        if (!isComfyInstall(settings.comfyRoot)) throw new Error('Choose a ComfyUI folder first.')
        this.progress('Downloading pinned LFM weights (about 0.8 GB) and installing the bridge node…')
        const backend = join(this.host.appRoot, 'backend')
        await runProcess(comfyPythonPath(settings.comfyRoot), [join(backend, 'setup_lfm.py'), '--comfy', settings.comfyRoot], {
          cwd: backend, signal, timeout: 60 * 60_000, onLine: line => { if (line.trim()) this.progress(line.trim().slice(0, 300)) }
        })
        this.updateSettings({ textEncoder: 'lfm' })
        return 'LFM bridge installed and selected. Restart ComfyUI so it loads the new node.'
      }
      case 'verify-llama': {
        if (!isComfyInstall(settings.comfyRoot)) throw new Error('Choose a ComfyUI folder first.')
        this.progress('Checking local Llama weights and Hugging Face access…')
        const out = await runProcess(comfyPythonPath(settings.comfyRoot), [join(this.host.appRoot, 'backend', 'preflight.py'), '--encoder', 'llm2vec'], { signal, timeout: 90_000 }).catch(error => {
          const text = errorText(error)
          return text.includes('STUDIO_CHECKS:') ? text : Promise.reject(error)
        })
        const line = out.split(/\r?\n/).find(s => s.startsWith('STUDIO_CHECKS:'))
        if (!line) throw new Error('The access check returned no result.')
        const checks = z.array(z.object({ name: z.string(), status: z.enum(['ready', 'warning', 'blocked']), detail: z.string() })).parse(JSON.parse(line.slice(14)))
        const check = checks.find(c => c.name.includes('text encoder')) ?? checks.find(c => c.status === 'blocked')
        if (!check) throw new Error('The access check returned no text-encoder result.')
        this.stored.llama = { status: check.status, detail: check.detail, checkedAt: new Date().toISOString() }
        await this.save()
        if (check.status === 'blocked') throw new Error(check.detail)
        return check.detail
      }
      case 'download-model': {
        if (!isComfyInstall(settings.comfyRoot)) throw new Error('Choose a ComfyUI folder first.')
        let pending: SetupModel[]
        if (modelId) pending = [setupModel(modelId)].filter(model => !sameSize(modelPath(settings.comfyRoot, model), model.bytes))
        else {
          this.progress('Checking installed models…')
          // "Download all" fetches only missing files: it skips equivalent Designer choices and never replaces a mismatched file.
          const report = await this.report()
          pending = setupModels.filter(model => report.items.find(item => item.id === `model:${model.id}`)?.status === 'todo')
        }
        if (!pending.length) return 'All selected models are already installed.'
        await ensureSpace(join(settings.comfyRoot), pending.reduce((sum, m) => sum + m.bytes, 0))
        for (const [index, model] of pending.entries()) {
          const prefix = pending.length > 1 ? `(${index + 1}/${pending.length}) ` : ''
          await downloadVerified(modelUrl(model), modelPath(settings.comfyRoot, model), { sha256: model.sha256, bytes: model.bytes }, {
            signal, onProgress: ({ received }) => this.progress(`${prefix}Downloading ${model.label}: ${formatBytes(received)} of ${formatBytes(model.bytes)}`, received / model.bytes)
          })
          this.selectDesignerModel(model)
        }
        return `${pending.length === 1 ? pending[0].label : `${pending.length} models`} downloaded, checksum-verified and available to Designer.`
      }
      default: throw new Error('Unsupported setup action.')
    }
  }

  private useComfy(root: string) {
    const settings = this.host.settings()
    const outputUnderOld = settings.comfyOutput === join(settings.comfyRoot, 'output')
    const outputMissing = !existsSync(settings.comfyOutput)
    this.updateSettings({ comfyRoot: root, ...(outputUnderOld || outputMissing ? { comfyOutput: join(root, 'output') } : {}) })
    return `ComfyUI folder saved: ${displayPath(root)}.`
  }

  /** Select a newly verified model in Designer only when the matching setting is empty, so existing choices are kept. */
  private selectDesignerModel(model: SetupModel) {
    try {
      const config = this.host.designerConfig()
      const current = config[model.configField]
      const defaults: Partial<Record<keyof DesignerConfig, string>> = { editModel: 'flux-2-klein-4b-fp8.safetensors', editTextEncoder: 'qwen_3_4b.safetensors', editVae: 'flux2-vae.safetensors' }
      if (current && current !== defaults[model.configField]) return
      const next: DesignerConfig = { ...config, [model.configField]: model.file }
      if (model.configField === 'meshCheckpoint') next.meshProfile = 'standard'
      if (model.configField === 'checkpoint') next.imageProfile = 'sd15'
      this.host.saveDesignerConfig(next)
    } catch { /* Designer may be busy; the model remains selectable in Designer model settings. */ }
  }

  private async installBlender(signal: AbortSignal): Promise<string> {
    const distribution = blenderDistribution()
    const tools = join(this.host.root, 'tools')
    const destination = join(tools, distribution.directory)
    const executable = join(destination, ...distribution.executable)
    if (!existsSync(executable)) {
      await mkdir(tools, { recursive: true })
      await ensureSpace(tools, 2 * 1024 ** 3)
      const staging = await mkdtemp(join(tools, 'blender-install-'))
      try {
        const archive = join(staging, distribution.archive)
        await downloadVerified(`https://mirror.blender.org/release/Blender4.5/${distribution.archive}`, archive, { sha256: distribution.sha256 }, {
          signal, onProgress: ({ received, total }) => this.progress(`Downloading Blender: ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ''}`, total ? received / total : undefined)
        })
        this.progress('Checksum verified. Extracting Blender…')
        if (process.platform === 'win32') {
          const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
          if (existsSync(tar)) await runProcess(tar, ['-xf', archive, '-C', staging], { signal, timeout: 30 * 60_000 })
          else {
            const quote = (v: string) => `'${v.replaceAll("'", "''")}'`
            await runProcess('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)}`], { signal, timeout: 30 * 60_000 })
          }
        } else if (process.platform === 'linux') {
          await runProcess('tar', ['-xJf', archive, '-C', staging], { signal, timeout: 30 * 60_000 })
        } else {
          const mount = join(staging, 'mount')
          await mkdir(mount)
          await runProcess('hdiutil', ['attach', archive, '-nobrowse', '-readonly', '-mountpoint', mount], { signal })
          try {
            await mkdir(join(staging, distribution.directory))
            await runProcess('ditto', [join(mount, 'Blender.app'), join(staging, distribution.directory, 'Blender.app')], { signal })
          } finally { await runProcess('hdiutil', ['detach', mount]).catch(() => undefined) }
        }
        await rm(destination, { recursive: true, force: true })
        await rename(join(staging, distribution.directory), destination)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
    this.progress('Verifying Blender…')
    const out = await runProcess(executable, ['--background', '--factory-startup', '--version'], { signal, timeout: 60_000 })
    this.updateSettings({ blenderPath: executable })
    return `${out.split(/\r?\n/).find(s => s.startsWith('Blender')) ?? 'Blender'} installed and selected.`
  }
}

function sameSize(file: string, bytes: number) {
  try { return statSync(file).size === bytes } catch { return false }
}

function labelFor(action: SetupActionId, model?: string): string {
  switch (action) {
    case 'install-blender': return 'Install Blender'
    case 'start-comfy': return 'Start ComfyUI'
    case 'install-lfm': return 'Install LFM bridge'
    case 'verify-llama': return 'Check Llama access'
    case 'download-model': return model ? `Download ${setupModel(model).label}` : 'Download Designer models'
    default: return 'Update setup'
  }
}
