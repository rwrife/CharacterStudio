import type { DesignerConfig } from './designer'

export type SetupItemId = 'system' | 'blender' | 'comfy-install' | 'comfy-output' | 'comfy-running' | 'kimodo-nodes' | 'text-encoder' | 'ollama' | `model:${SetupModelId}`
export type SetupGroup = 'core' | 'animator' | 'designer' | 'optional'
export type SetupStatus = 'done' | 'todo' | 'warning' | 'optional'
export type SetupActionId =
  | 'install-blender' | 'browse-blender'
  | 'detect-comfy' | 'browse-comfy' | 'open-comfy-guide'
  | 'use-default-output' | 'browse-output'
  | 'start-comfy'
  | 'open-kimodo-nodes'
  | 'install-lfm' | 'verify-llama' | 'open-llama-access'
  | 'download-model' | 'open-model-license'
  | 'open-ollama'
export type SetupModelId = 'dreamshaper-8' | 'flux2-klein-4b' | 'qwen3-4b' | 'flux2-vae' | 'birefnet' | 'hunyuan3d-2'

export interface SetupAction {
  id: SetupActionId
  label: string
  primary?: boolean
  model?: SetupModelId
  /** Reason the action cannot run yet. */
  disabled?: string
}
export interface SetupItem {
  id: SetupItemId
  group: SetupGroup
  title: string
  detail: string
  status: SetupStatus
  /** Workspaces that cannot generate until this item is done. */
  requiredFor: ('designer' | 'animator')[]
  actions: SetupAction[]
  bytes?: number
  /** Action the checklist and launch check start without a click (shown with progress and Cancel). */
  automatic?: SetupActionId
}
export interface SetupTask {
  item: SetupItemId
  action: SetupActionId
  label: string
  message: string
  /** 0..1 when measurable. */
  fraction?: number
}
export interface SetupState {
  firstLaunch: boolean
  showOnLaunch: boolean
  completedAt?: string
  /** Validate dependencies on launches that do not open the full checklist. */
  checkOnLaunch: boolean
  /** Items the user chose not to be warned about at launch until they are working again. */
  ignoredAtLaunch: SetupItemId[]
  task?: SetupTask
  /** Last finished task, so the checklist can report success or failure after it closes. */
  result?: { item: SetupItemId; ok: boolean; message: string }
}
export interface SetupReport {
  items: SetupItem[]
  ready: { designer: boolean; animator: boolean }
  checkedAt: string
}
/** Outcome of the cancellable dependency check run on later launches. */
export type LaunchCheck = { cancelled: true } | { cancelled: false; report: SetupReport; issues: SetupItem[] }

export interface SetupModel {
  id: SetupModelId
  label: string
  purpose: string
  /** Folder below ComfyUI's models directory. */
  folder: string
  file: string
  repo: string
  revision: string
  path: string
  bytes: number
  sha256: string
  license: string
  licenseUrl: string
  /** Designer setting selected after a verified download when it is still unset. */
  configField: keyof DesignerConfig
}

// Revisions, sizes and SHA-256 digests are pinned from the Hugging Face API so a changed upstream file fails verification.
export const setupModels: readonly SetupModel[] = [
  {
    id: 'dreamshaper-8', label: 'DreamShaper 8 (SD 1.5)', purpose: 'Scene concept checkpoint (4 GB GPU profile).',
    folder: 'checkpoints', file: 'DreamShaper_8_pruned.safetensors', repo: 'Lykon/DreamShaper',
    revision: '228d79cb20811466f5c5710aa91f05dabd0b8a14', path: 'DreamShaper_8_pruned.safetensors',
    bytes: 2132625894, sha256: '879db523c30d3b9017143d56705015e15a2cb5628762c11d086fed9538abd7fd',
    license: 'CreativeML Open RAIL-M', licenseUrl: 'https://huggingface.co/Lykon/DreamShaper', configField: 'checkpoint'
  },
  {
    id: 'flux2-klein-4b', label: 'FLUX.2 klein 4B FP8', purpose: 'T-pose image-editing model.',
    folder: 'diffusion_models', file: 'flux-2-klein-4b-fp8.safetensors', repo: 'black-forest-labs/FLUX.2-klein-4b-fp8',
    revision: '5b4408e59397a4a37ccb46afe426d8ed86379441', path: 'flux-2-klein-4b-fp8.safetensors',
    bytes: 4070624520, sha256: '97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6',
    license: 'Apache 2.0', licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8', configField: 'editModel'
  },
  {
    id: 'qwen3-4b', label: 'Qwen 3 4B text encoder', purpose: 'Text encoder for the T-pose editor.',
    folder: 'text_encoders', file: 'qwen_3_4b.safetensors', repo: 'Comfy-Org/z_image_turbo',
    revision: '6fc90a3b1b653e935a0d175e260736de25b84df5', path: 'split_files/text_encoders/qwen_3_4b.safetensors',
    bytes: 8044982048, sha256: '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a',
    license: 'Apache 2.0', licenseUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo', configField: 'editTextEncoder'
  },
  {
    id: 'flux2-vae', label: 'FLUX.2 autoencoder', purpose: 'Image autoencoder for the T-pose editor.',
    folder: 'vae', file: 'flux2-vae.safetensors', repo: 'Comfy-Org/flux2-dev',
    revision: '9630c1b4b6e690497ae0c19bb6b1b35d4ebedcb7', path: 'split_files/vae/flux2-vae.safetensors',
    bytes: 336213556, sha256: 'd64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5',
    license: 'Apache 2.0 (autoencoder)', licenseUrl: 'https://github.com/black-forest-labs/flux2#flux2-autoencoder', configField: 'editVae'
  },
  {
    id: 'birefnet', label: 'BiRefNet background removal', purpose: 'Transparent T-pose cutouts.',
    folder: 'background_removal', file: 'birefnet.safetensors', repo: 'Comfy-Org/BiRefNet',
    revision: '884af709e9b795d89dafbf97f29c8d6a2386f5c6', path: 'background_removal/birefnet.safetensors',
    bytes: 444473596, sha256: '9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154',
    license: 'MIT', licenseUrl: 'https://huggingface.co/Comfy-Org/BiRefNet', configField: 'backgroundModel'
  },
  {
    id: 'hunyuan3d-2', label: 'Hunyuan3D 2 (geometry)', purpose: 'Single-view image-to-3D geometry (10 GB GPU profile).',
    folder: 'checkpoints', file: 'hunyuan3d-dit-v2_fp16.safetensors', repo: 'Comfy-Org/hunyuan3D_2.0_repackaged',
    revision: '15c2937a842a1f8cb5cedc840790ef973b583e5f', path: 'split_files/hunyuan3d-dit-v2_fp16.safetensors',
    bytes: 4928151562, sha256: '360bc281fc956d4acac0c3d36d5ec0ebf8cdddbf4b8892e894d12419388d479b',
    license: 'Tencent Hunyuan Community License (territory restrictions apply)',
    licenseUrl: 'https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged/blob/main/LICENSE', configField: 'meshCheckpoint'
  }
]

export function setupModel(id: string): SetupModel {
  const model = setupModels.find(m => m.id === id)
  if (!model) throw new Error('Unknown setup model.')
  return model
}

export function modelUrl(model: SetupModel): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.path.split('/').map(encodeURIComponent).join('/')}`
}

/** Fixed external pages the checklist may open. The renderer can only name an action, never a URL. */
export const setupLinks = {
  comfyGuide: 'https://docs.comfy.org/installation/manual_install',
  kimodoNodes: 'https://github.com/jtydhr88/ComfyUI-Kimodo',
  llamaAccess: 'https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct',
  ollama: 'https://ollama.com/download'
} as const

export function summarizeSetup(items: SetupItem[]): SetupReport['ready'] {
  const ready = (workspace: 'designer' | 'animator') => items.every(item => !item.requiredFor.includes(workspace) || item.status === 'done')
  return { designer: ready('designer'), animator: ready('animator') }
}

/** Required dependencies that are not working, minus those the user ignored at launch. */
export function launchIssues(items: SetupItem[], ignored: readonly string[]): SetupItem[] {
  return items.filter(item => item.requiredFor.length > 0 && item.status !== 'done' && !ignored.includes(item.id))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
