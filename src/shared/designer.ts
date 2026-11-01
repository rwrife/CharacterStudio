export type ImageProfile = 'sd15' | 'sdxl'
export type MeshProfile = 'mini' | 'standard' | 'textured'
export type DesignStage = 'scene' | 'tpose' | 'model'
export interface DesignerConfig {
  imageProfile: ImageProfile
  checkpoint: string
  controlnet: string
  meshProfile: MeshProfile
  meshCheckpoint: string
  titleModel: string
  ipadapter?: string
  clipVision?: string
  backgroundModel?: string
  editModel?: string
  editTextEncoder?: string
  editVae?: string
  meshTextureModel?: string
  meshVision?: string
  meshShapeVae?: string
  meshTextureVae?: string
}
export interface DesignRequest {
  title: string
  description: string
  style: string
  referenceId?: string
  seed: number
  steps: number
  referenceStrength: number
}
export interface DesignReference { id: string; name: string; url: string }
export interface DesignImportRequest {
  stage: Exclude<DesignStage, 'scene'>
  brief: DesignRequest
  isolated: boolean
}
export interface DesignSource {
  kind: 'imported' | 'generated'
  name?: string
  input?: DesignStage
}
export interface Design {
  id: string
  createdAt: string
  title: string
  request: DesignRequest
  config: DesignerConfig
  status: 'idle' | 'running' | 'failed' | 'cancelled'
  stage?: DesignStage
  message: string
  promptId?: string
  sceneUrl?: string
  tposeUrl?: string
  tposeIsolated?: boolean
  modelUrl?: string
  modelTextured?: boolean
  characterId?: string
  sources?: Partial<Record<DesignStage, DesignSource>>
}
export interface DesignerSnapshot {
  config: DesignerConfig
  references: DesignReference[]
  designs: Design[]
}
export interface DesignerReadiness {
  devices: { name: string; totalGB: number; freeGB: number }[]
  checkpoints: string[]
  controlnets: string[]
  titleModels: string[]
  titleError?: string
  ipadapters: string[]
  clipVision: string[]
  backgroundModels: string[]
  diffusionModels: string[]
  textEncoders: string[]
  vaes: string[]
}
// Conservative working budgets, not guaranteed minima. Runtime availability is checked per stage.
export const imageProfiles = {
  sd15: { label: 'SD 1.5 / DreamShaper', gb: 4, size: 512 },
  sdxl: { label: 'SDXL', gb: 8, size: 1024 }
}
export const meshProfiles = {
  mini: { label: 'Hunyuan3D 2mini (geometry)', gb: 6, resolution: 128 },
  standard: { label: 'Hunyuan3D 2 (geometry)', gb: 10, resolution: 256 },
  textured: { label: 'TRELLIS.2 (textured)', gb: 24, resolution: 512 }
}
export const meshTextureProfile = {
  model: 'trellis_2_int8_convrot.safetensors', vision: 'dino_v3_L_naf_fp32.safetensors',
  shapeVae: 'trellis_2_shape_vae_bf16.safetensors', textureVae: 'trellis_2_texture_vae_bf16.safetensors',
  textureSize: 1024, faceCount: 50000
}
export const tposeEditProfile = {
  label: 'FLUX.2 klein 4B (image edit)', gb: 14, steps: 4,
  model: 'flux-2-klein-4b-fp8.safetensors', textEncoder: 'qwen_3_4b.safetensors', vae: 'flux2-vae.safetensors'
}
export const tposeEditPrompt = 'Put this character in a T-pose, remove the background, only show the character. Preserve the same face, hairstyle, clothing, colors, body proportions and art style. Full body, front view, both arms straight out horizontally, hands and feet fully visible with a clear margin. Both hands flat with palms facing down, fingers straight and held together side by side, thumbs resting naturally alongside. No splayed or curled fingers and no fists. Do not redesign the character or add clothing, accessories or scenery.'
