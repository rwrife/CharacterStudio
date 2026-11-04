import { localRoute, type AiConfiguration, type AiHardware, type AiStage } from './ai'
import { imageProfiles, meshProfiles, tposeEditProfile, type DesignerConfig } from './designer'
import { designerModelPackages } from './designer-models'

export const recommendedDesignerConfig: DesignerConfig = {
  imageProfile: 'sd15', checkpoint: designerModelPackages.sd15.models[0].file, controlnet: '',
  meshProfile: 'standard', meshCheckpoint: designerModelPackages.hunyuan.models[0].file, titleModel: '',
  ipadapter: '', clipVision: '', editModel: tposeEditProfile.model, editTextEncoder: tposeEditProfile.textEncoder,
  editVae: tposeEditProfile.vae, backgroundModel: designerModelPackages.background.models[0].file
}

export const recommendedModelFields: Partial<Record<AiStage, Partial<DesignerConfig>>> = {
  scene: { imageProfile: recommendedDesignerConfig.imageProfile, checkpoint: recommendedDesignerConfig.checkpoint, controlnet: '', ipadapter: '', clipVision: '' },
  tpose: { editModel: recommendedDesignerConfig.editModel, editTextEncoder: recommendedDesignerConfig.editTextEncoder, editVae: recommendedDesignerConfig.editVae },
  cutout: { backgroundModel: recommendedDesignerConfig.backgroundModel },
  mesh: { meshProfile: recommendedDesignerConfig.meshProfile, meshCheckpoint: recommendedDesignerConfig.meshCheckpoint },
  naming: { titleModel: '' }
}

export function recommendedTaskSetup(ai: AiConfiguration, native: DesignerConfig | undefined, stage: AiStage) {
  return {
    ai: { ...ai, stages: { ...ai.stages, [stage]: { ...localRoute } } },
    native: native ? { ...native, ...recommendedModelFields[stage] } : native
  }
}

export function nativeTaskSummary(stage: AiStage, config: DesignerConfig | undefined, encoder: 'llm2vec' | 'lfm') {
  switch (stage) {
    case 'scene': return { name: config ? imageProfiles[config.imageProfile].label : 'SD 1.5 / DreamShaper', gb: config ? imageProfiles[config.imageProfile].gb : 4, purpose: 'Create a character concept from a brief or reference.' }
    case 'tpose': return { name: 'FLUX.2 klein 4B + BiRefNet', gb: tposeEditProfile.gb + 2, purpose: 'Edit the scene into a T-pose, then remove its background. Required components work together.' }
    case 'cutout': return { name: 'BiRefNet', gb: 2, purpose: 'Remove the background for a transparent character reference.' }
    case 'mesh': return { name: config ? meshProfiles[config.meshProfile].label : meshProfiles.mini.label, gb: config ? meshProfiles[config.meshProfile].gb : 6, purpose: 'Build an unrigged GLB from a transparent T-pose.' }
    case 'motion': return { name: encoder === 'lfm' ? 'Kimodo + LFM bridge (experimental)' : 'Kimodo + Llama / LLM2Vec', gb: encoder === 'lfm' ? undefined : 24, purpose: encoder === 'lfm' ? 'Smaller experimental encoder; exact memory requirements are not established. Motion quality and constrained graphs are not production-validated.' : 'Generate motion with the original trained encoder. Gated model access is required.' }
    case 'capture': return { name: 'MediaPipe Pose', purpose: 'CPU capture in the visible Mocap workspace. Pose Lite and Full remain available in Capture options.' }
    case 'naming': return { name: config?.titleModel || 'Manual character title', purpose: config?.titleModel ? 'Optional local Ollama model; requirements depend on the selected model.' : 'Name the character yourself. No extra model needed.' }
    case 'texture': return { name: 'No separate texture model', purpose: 'Use TRELLIS.2 in the mesh task for a new textured GLB, or configure a remote/custom post-texturing provider in Advanced.' }
    case 'rig': return { name: 'Local Blender preparation', purpose: 'Guided body rigging is not universal auto-rigging. Remote rigging is an explicit Advanced option.' }
    default: return { name: 'Not implemented', purpose: 'Reserved extension point, not an available AI feature.' }
  }
}

export function memoryGuidance(hardware: AiHardware | undefined, gb: number): string {
  const devices = hardware?.devices.filter(device => ['cuda', 'hip', 'rocm'].includes(device.type ?? '') &&
    Number.isFinite(device.freeGB) && Number.isFinite(device.totalGB) &&
    device.freeGB >= 0 && device.totalGB > 0 && device.freeGB <= device.totalGB)
  if (!devices?.length) return 'Dedicated GPU memory unknown or shared/unified; compatibility not established'
  return devices.some(device => device.freeGB >= gb) ? 'Available memory meets the estimate; compatibility still needs checking' :
    'Below estimated free GPU memory; use an import or explicitly configured remote provider'
}
