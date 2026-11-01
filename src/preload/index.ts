import { contextBridge, ipcRenderer } from 'electron'
import type { StudioApi, Snapshot } from '../shared/types'

const api: StudioApi = {
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
  designerSettings: config => ipcRenderer.invoke('designer:settings', config),
  designerReference: () => ipcRenderer.invoke('designer:reference'),
  designerCreate: request => ipcRenderer.invoke('designer:create', request),
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
  rig: id => ipcRenderer.invoke('studio:rig', id),
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
  onUpdate: callback => {
    const listener = (_: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot)
    ipcRenderer.on('studio:update', listener)
    return () => ipcRenderer.removeListener('studio:update', listener)
  }
}
contextBridge.exposeInMainWorld('studio', api)
