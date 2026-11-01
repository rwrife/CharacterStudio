export type ImageProfile = 'sd15' | 'sdxl'
export type MeshProfile = 'mini' | 'standard'
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
  characterId?: string
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
}
// Conservative working budgets, not guaranteed minima. Runtime availability is checked per stage.
export const imageProfiles = {
  sd15: { label: 'SD 1.5 / DreamShaper', gb: 4, size: 512 },
  sdxl: { label: 'SDXL', gb: 8, size: 1024 }
}
export const meshProfiles = {
  mini: { label: 'Hunyuan3D 2mini (geometry)', gb: 6, resolution: 128 },
  standard: { label: 'Hunyuan3D 2 (geometry)', gb: 10, resolution: 256 }
}
