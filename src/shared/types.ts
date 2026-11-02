export type Vec3 = [number, number, number]
export type Landmarks = Record<string, Vec3>
export type SkinningMode = 'automatic' | 'fallback'
export interface RigSetup {
  rotation: Vec3
  landmarks: Landmarks
}
export interface LandmarkSuggestion {
  landmarks: Landmarks
  warnings: string[]
}
export interface Settings {
  comfyUrl: string
  comfyRoot: string
  comfyOutput: string
  blenderPath: string
  textEncoder?: 'llm2vec' | 'lfm'
}
export interface Character {
  id: string
  name: string
  importedAt: string
  previewUrl: string
  vertices: number
  meshes: number
  warnings: string[]
  setup: RigSetup
  rigged: boolean
  rigPreviewUrl?: string
  rigWarnings?: string[]
}
export type Stage = 'importing' | 'rigging' | 'preflight' | 'queued' | 'generating' | 'retargeting' | 'complete' | 'failed' | 'cancelled'
export interface Job {
  id: string
  characterId: string
  characterName: string
  kind: 'rig' | 'generate' | 'import'
  stage: Stage
  message: string
  progress: number
  createdAt: string
  prompt?: string
  seconds?: number
  seed?: number
  steps?: number
  inPlace?: boolean
  promptId?: string
  previewUrl?: string
  outputFiles?: string[]
  warnings?: string[]
  rigFailure?: 'unweighted'
  parentJobId?: string
  label?: string
  batchId?: string
  planNodeId?: string
  reusedMotionFrom?: string
  graphContext?: GraphContext
  clipPreviewUrl?: string
  transitionPreviewUrl?: string
  textEncoder?: 'llm2vec' | 'lfm'
  ai?: import('./ai').AiProvenance[]
}
export interface Check {
  name: string
  status: 'ready' | 'blocked' | 'warning'
  detail: string
  gpu?: { name: string; totalGB: number; freeGB: number }
}
export interface GenerateRequest {
  characterId: string
  prompt: string
  seconds: number
  seed: number
  steps: number
  inPlace: boolean
  parentJobId?: string
}
export interface MotionNode {
  id: string
  label: string
  prompt: string
  seconds: number
  seed: number
  steps: number
  inPlace: boolean
  kind: 'state' | 'action'
  loop: boolean
  stance: string
  position: { x: number; y: number }
  legacySegments?: boolean
}
export interface MotionEdge {
  id: string
  source: string
  target: string
  seconds: number
}
export interface MotionPlan {
  id: string
  name: string
  rigSetup: RigSetup
  nodes: MotionNode[]
  graphVersion: 2
  edges: MotionEdge[]
  entryNodeIds: string[]
}
export interface GraphContext {
  key: string
  path: string[]
  pathLabel: string
  parentKey?: string
  inheritedStance: string
  resultingStance: string
  effectivePrompt: string
  transitionSeconds: number
  cycleEnd: boolean
}
export interface BatchRequest {
  planId: string
  characterIds: string[]
  seedStride: number
  autoRig: boolean
}
export interface BatchItem {
  id: string
  characterId: string
  characterName: string
  nodeId: string
  label: string
  seed: number
  status: 'pending' | 'running' | 'complete' | 'failed' | 'blocked' | 'cancelled'
  jobId?: string
  message?: string
  context?: GraphContext
  parentItemId?: string
}
export interface Batch {
  id: string
  name: string
  createdAt: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  plan: MotionPlan
  request: BatchRequest
  items: BatchItem[]
  textEncoder?: 'llm2vec' | 'lfm'
  aiRoute?: import('./ai').AiRoute
}
export interface Snapshot {
  settings: Settings
  characters: Character[]
  jobs: Job[]
  plans: MotionPlan[]
  batches: Batch[]
  designer?: import('./designer').DesignerSnapshot
  ai?: import('./ai').AiConfiguration
}
export interface StudioApi {
  aiSettings(config: import('./ai').AiConfiguration): Promise<void>
  aiHardware(): Promise<import('./ai').AiHardware>
  aiImportWorkflow(): Promise<import('./ai').WorkflowTemplate | null>
  aiCredentialStatus(target: import('./ai').AiCredentialTarget): Promise<boolean>
  aiCredential(target: import('./ai').AiCredentialTarget, value: string): Promise<void>
  aiBalance(target: import('./ai').AiCredentialTarget): Promise<{ balance: number; frozen: number }>
  onAiConsent(callback: (request: import('./ai').AiConsent | null) => void): () => void
  aiConsentReply(id: string, approved: boolean): Promise<void>
  designerProcessModel(id: string, stage: 'rig' | 'texture'): Promise<string>
  desktopControlEnabled(): Promise<boolean>
  setDesktopControlEnabled(enabled: boolean): Promise<boolean>
  onDesktopControlChanged(callback: (enabled: boolean) => void): () => void
  onFileDialog(callback: (dialog: import('./file-dialog').FileDialogRequest | null) => void): () => void
  fileDialogReply(id: string, paths: string[] | null, overwrite: boolean): Promise<void>
  fileDialogBrowse(id: string): Promise<string[] | null>
  designerReadiness(): Promise<import('./designer').DesignerReadiness>
  designerInstallModels(id: import('./designer-models').DesignerModelPackage): Promise<import('./designer').DesignerConfig | null>
  designerCancelDownload(): Promise<void>
  designerSettings(config: import('./designer').DesignerConfig): Promise<void>
  designerReference(): Promise<import('./designer').DesignReference | null>
  designerCreate(request: import('./designer').DesignRequest): Promise<string>
  designerVariation(id: string, stage: import('./designer').DesignStage, request: import('./designer').DesignRequest): Promise<string>
  designerImport(request: import('./designer').DesignImportRequest): Promise<string | null>
  designerRun(id: string, stage: import('./designer').DesignStage): Promise<void>
  designerCancel(): Promise<void>
  designerExport(id: string, stage: import('./designer').DesignStage): Promise<string | null>
  designerAnimate(id: string): Promise<Character>
  snapshot(): Promise<Snapshot>
  settings(settings: Settings): Promise<Settings>
  browse(kind: 'blender' | 'comfy' | 'output'): Promise<string | null>
  importCharacter(): Promise<Character | null>
  importCollection(): Promise<Character[]>
  saveSetup(id: string, setup: RigSetup): Promise<Character>
  fitLandmarks(id: string, rotation: Vec3): Promise<LandmarkSuggestion>
  rig(id: string, skinning?: SkinningMode): Promise<void>
  generate(request: GenerateRequest): Promise<void>
  cancel(): Promise<void>
  check(): Promise<Check[]>
  startComfy(): Promise<void>
  saveOutput(jobId: string, file: string): Promise<string | null>
  openAccessPage(): Promise<void>
  openTokenSettings(): Promise<void>
  revealData(): Promise<void>
  savePlan(plan: MotionPlan): Promise<MotionPlan>
  importPlan(): Promise<MotionPlan | null>
  exportPlan(id: string): Promise<string | null>
  runBatch(request: BatchRequest): Promise<void>
  rerunBatch(id: string): Promise<void>
  exportBatch(id: string): Promise<string | null>
  onUpdate(callback: (snapshot: Snapshot) => void): () => void
  setupState(): Promise<import('./setup').SetupState>
  setupReport(): Promise<import('./setup').SetupReport>
  setupRun(request: { item: import('./setup').SetupItemId; action: import('./setup').SetupActionId; model?: import('./setup').SetupModelId }): Promise<import('./setup').SetupState>
  setupCancel(): Promise<void>
  setupPreferences(value: { showOnLaunch?: boolean; completed?: boolean; checkOnLaunch?: boolean; ignoredAtLaunch?: import('./setup').SetupItemId[] }): Promise<import('./setup').SetupState>
  setupLaunchCheck(): Promise<import('./setup').LaunchCheck>
  setupCancelLaunchCheck(): Promise<void>
  onSetupUpdate(callback: (state: import('./setup').SetupState) => void): () => void
}
