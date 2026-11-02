import { contextBridge, ipcRenderer } from 'electron'
import type { StudioApi, Snapshot } from '../shared/types'
import type { SetupState } from '../shared/setup'

const api: StudioApi = {
  aiSettings: config => ipcRenderer.invoke('ai:settings', config),
  aiHardware: () => ipcRenderer.invoke('ai:hardware'),
  aiImportWorkflow: () => ipcRenderer.invoke('ai:import-workflow'),
  aiCredentialStatus: target => ipcRenderer.invoke('ai:credential-status', target),
  aiCredential: (target, value) => ipcRenderer.invoke('ai:credential', target, value),
  aiBalance: target => ipcRenderer.invoke('ai:balance', target),
  aiConsentReply: (id, approved) => ipcRenderer.invoke('ai:consent-reply', id, approved),
  onAiConsent: callback => {
    const listener = (_: Electron.IpcRendererEvent, request: import('../shared/ai').AiConsent | null) => callback(request)
    ipcRenderer.on('ai:consent', listener)
    return () => ipcRenderer.removeListener('ai:consent', listener)
  },
  designerProcessModel: (id, stage) => ipcRenderer.invoke('designer:process-model', id, stage),
  desktopControlEnabled: () => ipcRenderer.invoke('studio:mcp-enabled'),
  setDesktopControlEnabled: enabled => ipcRenderer.invoke('studio:mcp-set-enabled', enabled),
  onDesktopControlChanged: callback => {
    const listener = (_: Electron.IpcRendererEvent, enabled: boolean) => callback(enabled)
    ipcRenderer.on('studio:mcp-changed', listener)
    return () => ipcRenderer.removeListener('studio:mcp-changed', listener)
  },
  onFileDialog: callback => {
    const listener = (_: Electron.IpcRendererEvent, request: import('../shared/file-dialog').FileDialogRequest | null) => callback(request)
    ipcRenderer.on('studio:file-dialog', listener)
    return () => ipcRenderer.removeListener('studio:file-dialog', listener)
  },
  fileDialogReply: (id, paths, overwrite) => ipcRenderer.invoke('studio:file-dialog-reply', id, paths, overwrite),
  fileDialogBrowse: id => ipcRenderer.invoke('studio:file-dialog-browse', id),
  designerReadiness: () => ipcRenderer.invoke('designer:readiness'),
  designerInstallModels: id => ipcRenderer.invoke('designer:install-models', id),
  designerCancelDownload: () => ipcRenderer.invoke('designer:cancel-download'),
  designerSettings: config => ipcRenderer.invoke('designer:settings', config),
  designerReference: () => ipcRenderer.invoke('designer:reference'),
  designerCreate: request => ipcRenderer.invoke('designer:create', request),
  designerVariation: (id, stage, request) => ipcRenderer.invoke('designer:variation', id, stage, request),
  designerImport: request => ipcRenderer.invoke('designer:import', request),
  designerRun: (id, stage) => ipcRenderer.invoke('designer:run', id, stage),
  designerCancel: () => ipcRenderer.invoke('designer:cancel'),
  designerExport: (id, stage) => ipcRenderer.invoke('designer:export', id, stage),
  designerAnimate: id => ipcRenderer.invoke('designer:animate', id),
  snapshot: () => ipcRenderer.invoke('studio:snapshot'),
  settings: settings => ipcRenderer.invoke('studio:settings', settings),
  browse: kind => ipcRenderer.invoke('studio:browse', kind),
  importCharacter: () => ipcRenderer.invoke('studio:import'),
  importCollection: () => ipcRenderer.invoke('studio:import-collection'),
  saveSetup: (id, setup) => ipcRenderer.invoke('studio:setup', id, setup),
  fitLandmarks: (id, rotation) => ipcRenderer.invoke('studio:fit-landmarks', id, rotation),
  rig: (id, skinning) => ipcRenderer.invoke('studio:rig', id, skinning),
  generate: request => ipcRenderer.invoke('studio:generate', request),
  cancel: () => ipcRenderer.invoke('studio:cancel'),
  check: () => ipcRenderer.invoke('studio:check'),
  startComfy: () => ipcRenderer.invoke('studio:start-comfy'),
  saveOutput: (job, file) => ipcRenderer.invoke('studio:save-output', job, file),
  openAccessPage: () => ipcRenderer.invoke('studio:access-page'),
  openTokenSettings: () => ipcRenderer.invoke('studio:token-settings'),
  revealData: () => ipcRenderer.invoke('studio:reveal-data'),
  savePlan: plan => ipcRenderer.invoke('studio:save-plan', plan),
  importPlan: () => ipcRenderer.invoke('studio:import-plan'),
  exportPlan: id => ipcRenderer.invoke('studio:export-plan', id),
  runBatch: request => ipcRenderer.invoke('studio:run-batch', request),
  rerunBatch: id => ipcRenderer.invoke('studio:rerun-batch', id),
  exportBatch: id => ipcRenderer.invoke('studio:export-batch', id),
  mocapImportCharacter: () => ipcRenderer.invoke('mocap:import-character'),
  mocapImportVideo: () => ipcRenderer.invoke('mocap:import-video'),
  mocapSaveRecording: data => ipcRenderer.invoke('mocap:save-recording', data),
  mocapSaveCapture: (takeId, capture) => ipcRenderer.invoke('mocap:save-capture', takeId, capture),
  mocapReadCapture: takeId => ipcRenderer.invoke('mocap:read-capture', takeId),
  mocapCapture: request => ipcRenderer.invoke('mocap:capture', request),
  mocapDeleteTake: takeId => ipcRenderer.invoke('mocap:delete-take', takeId),
  mocapDownloadModel: model => ipcRenderer.invoke('mocap:download-model', model),
  mocapCancelDownload: () => ipcRenderer.invoke('mocap:cancel-download'),
  mocapModel: model => ipcRenderer.invoke('mocap:model', model),
  mocapExport: request => ipcRenderer.invoke('mocap:export', request),
  onUpdate: callback => {
    const listener = (_: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot)
    ipcRenderer.on('studio:update', listener)
    return () => ipcRenderer.removeListener('studio:update', listener)
  },
  setupState: () => ipcRenderer.invoke('setup:state'),
  setupReport: () => ipcRenderer.invoke('setup:report'),
  setupRun: request => ipcRenderer.invoke('setup:run', request),
  setupCancel: () => ipcRenderer.invoke('setup:cancel'),
  setupPreferences: value => ipcRenderer.invoke('setup:preferences', value),
  setupLaunchCheck: () => ipcRenderer.invoke('setup:launch-check'),
  setupCancelLaunchCheck: () => ipcRenderer.invoke('setup:cancel-launch-check'),
  onSetupUpdate: callback => {
    const listener = (_: Electron.IpcRendererEvent, state: SetupState) => callback(state)
    ipcRenderer.on('setup:update', listener)
    return () => ipcRenderer.removeListener('setup:update', listener)
  }
}
contextBridge.exposeInMainWorld('studio', api)
