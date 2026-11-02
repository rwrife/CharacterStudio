import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, shell } from 'electron'
import { copyFile, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Studio } from './studio'
import { errorText, rotationSchema } from './validation'
import type { GenerateRequest, RigSetup, Settings, MotionPlan, BatchRequest } from '../shared/types'
import type { DesignRequest, DesignerConfig, DesignStage, DesignImportRequest } from '../shared/designer'
import { designImportSchema } from './designer'
import { validateCutout } from './image-validation'
import { SetupAssistant, type SetupPreferences } from './setup'
import type { SetupActionId } from '../shared/setup'
import { z } from 'zod'
import { FileDialogs } from './file-dialogs'
import { startDesktopMcp } from './mcp-server'
import { desktopAdapter } from './mcp-desktop'
import { DesktopMcpControl } from './mcp-control'

protocol.registerSchemesAsPrivileged([{ scheme: 'studio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
let window: BrowserWindow
let studio: Studio
let quitting = false
const mcpRequested = process.argv.includes('--mcp')
let mcp: DesktopMcpControl | undefined
let files: FileDialogs | undefined
app.setName('Character Studio')
// Keep the established data directory so the product rename does not hide existing work.
app.setPath('userData', process.env.STUDIO_DATA_DIR ?? join(app.getPath('appData'), 'KimodoStudio'))
const ownsWorkspace = app.requestSingleInstanceLock()
if (!ownsWorkspace) app.quit()
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
})

if (ownsWorkspace) app.whenReady().then(async () => {
  // Automation that drives other workflows can opt out of the first-launch checklist.
  const quietLaunch = process.env.STUDIO_SKIP_SETUP_CHECKLIST === '1'
  const firstLaunch = !quietLaunch && !existsSync(join(app.getPath('userData'), 'studio.json'))
  studio = new Studio(app.getPath('userData'), app.getAppPath(), async (file, cutout, squareSize) => {
    if ((await stat(file)).size > 20 * 1024 * 1024) throw new Error('Reference image exceeds 20 MB.')
    const image = nativeImage.createFromBuffer(await readFile(file))
    const { width, height } = image.getSize()
    if (image.isEmpty() || !width || !height || width * height > 32_000_000) throw new Error('Reference image is invalid or exceeds 32 megapixels.')
    if (cutout) validateCutout(image.toBitmap(), width, height)
    if (squareSize) {
      const inner = squareSize - Math.ceil(squareSize * 0.08)
      const scaled = image.resize(width >= height ? { width: inner, quality: 'best' } : { height: inner, quality: 'best' })
      const dimensions = scaled.getSize()
      const source = scaled.toBitmap(), canvas = Buffer.alloc(squareSize * squareSize * 4)
      const left = Math.floor((squareSize - dimensions.width) / 2), top = Math.floor((squareSize - dimensions.height) / 2)
      for (let y = 0; y < dimensions.height; y++) source.copy(canvas, ((top + y) * squareSize + left) * 4, y * dimensions.width * 4, (y + 1) * dimensions.width * 4)
      return nativeImage.createFromBitmap(canvas, { width: squareSize, height: squareSize }).toPNG()
    }
    return image.toPNG()
  })
  protocol.handle('studio', async request => {
    const url = new URL(request.url)
    const file = url.hostname === 'asset' && !url.search ? studio.assets.get(url.pathname.slice(1)) : undefined
    if (!file) return new Response('Unknown local asset', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  window = new BrowserWindow({
    title: 'Character Studio', width: 1440, height: 960, minWidth: 1100, minHeight: 760,
    icon: join(import.meta.dirname, '../renderer/icon.png'),
    backgroundColor: '#111313', autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const fileDialogs = new FileDialogs(window, false)
  files = fileDialogs
  const mcpControl = new DesktopMcpControl(studio.root,
    () => startDesktopMcp(desktopAdapter(window, () => studio.snapshot()), studio.root),
    enabled => {
      fileDialogs.setControlled(enabled)
      if (!window.isDestroyed()) window.webContents.send('studio:mcp-changed', enabled)
    })
  mcp = mcpControl
  window.webContents.on('did-start-loading', () => fileDialogs.cancel())
  window.on('closed', () => fileDialogs.cancel())
  const allowedRenderer = process.env.ELECTRON_RENDERER_URL
  function handle(channel: string, callback: (...args: never[]) => unknown) {
    ipcMain.handle(channel, (event, ...args) => {
      const url = event.senderFrame?.url
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          !(allowedRenderer ? url?.startsWith(allowedRenderer + '/') || url === allowedRenderer : url === pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).toString()))
        throw new Error('Untrusted desktop IPC caller.')
      return callback(...args as never[])
    })
  }
  studio.onUpdate = snapshot => { if (!window.isDestroyed()) window.webContents.send('studio:update', snapshot) }
  handle('studio:mcp-enabled', () => mcpControl.enabled)
  handle('studio:mcp-set-enabled', (enabled: unknown) => mcpControl.setEnabled(z.boolean().parse(enabled)))
  handle('studio:file-dialog-reply', (...args: unknown[]) => {
    const [id, paths, overwrite] = z.tuple([z.string().uuid(), z.array(z.string().min(1).max(32768)).max(32).nullable(), z.boolean()]).parse(args)
    return fileDialogs.reply(id, paths, overwrite)
  })
  handle('studio:file-dialog-browse', (value: unknown) => fileDialogs.browse(z.string().uuid().parse(value)))
  const browse = async (kind: string) => {
    if (!['blender', 'comfy', 'output'].includes(kind)) throw new Error('Invalid path selector')
    const result = await fileDialogs.showOpenDialog(window, {
      title: kind === 'blender' ? 'Choose native Blender executable' : kind === 'comfy' ? 'Choose ComfyUI backend folder (contains main.py)' : 'Choose ComfyUI output folder',
      properties: kind === 'blender' ? ['openFile'] : ['openDirectory'],
      ...(kind === 'blender' && process.platform === 'win32' ? { filters: [{ name: 'Blender', extensions: ['exe'] }] } : {})
    })
    return result.canceled ? null : result.filePaths[0]
  }
  const lifetime = new AbortController()
  app.once('before-quit', () => lifetime.abort())
  const setup = new SetupAssistant({
    root: app.getPath('userData'), appRoot: app.getAppPath(), firstLaunch, quietLaunch, autoInstall: process.env.STUDIO_NO_AUTO_INSTALL !== '1', signal: lifetime.signal,
    settings: () => studio.snapshot().settings,
    saveSettings: value => studio.saveSettings(value),
    startComfy: () => studio.startComfy(),
    designerConfig: () => studio.designer.snapshot().config,
    saveDesignerConfig: value => studio.designer.saveSettings(value),
    choose: kind => browse(kind),
    openExternal: url => shell.openExternal(url),
    notify: state => { if (!window.isDestroyed()) window.webContents.send('setup:update', state) }
  })
  handle('setup:state', () => setup.state())
  handle('setup:report', () => setup.report())
  handle('setup:run', (request: { item: string; action: SetupActionId; model?: string }) => setup.run(request))
  handle('setup:cancel', () => setup.cancel())
  handle('setup:preferences', (value: SetupPreferences) => setup.preferences(value))
  handle('setup:launch-check', () => setup.launchCheck())
  handle('setup:cancel-launch-check', () => setup.cancelLaunchCheck())
  handle('studio:snapshot', () => studio.snapshot())
  handle('designer:readiness', () => studio.designer.readiness())
  handle('designer:install-models', (id: import('../shared/designer-models').DesignerModelPackage) =>
    studio.designer.installModels(id, async (label, models, root) => {
      const choice = await dialog.showMessageBox(window, {
        type: 'question', title: 'Download required models', message: label,
        detail: `Download and select up to ${(models.reduce((sum, model) => sum + model.bytes, 0) / 2 ** 30).toFixed(2)} GiB from Hugging Face into:\n${join(root, 'models')}\n\n` +
          models.map(model => `${model.file} (${(model.bytes / 2 ** 30).toFixed(2)} GiB)\n${model.license}\n${model.page}`).join('\n\n') +
          '\n\nReview the upstream model terms before use. Matching verified files are reused; other existing files are never overwritten. No character assets or credentials are uploaded. No Python packages are installed. Generation will not restart automatically.',
        buttons: ['Cancel', 'Download & select'], defaultId: 0, cancelId: 0, noLink: true
      })
      return choice.response === 1
    }))
  handle('designer:cancel-download', () => studio.designer.cancelDownload())
  handle('designer:settings', (config: DesignerConfig) => studio.designer.saveSettings(config))
  handle('designer:create', (request: DesignRequest) => studio.designer.create(request))
  handle('designer:variation', (id: string, stage: DesignStage, request: DesignRequest) => studio.designer.variation(id, stage, request))
  handle('designer:import', async (value: DesignImportRequest) => {
    const request = designImportSchema.parse(value)
    const result = await fileDialogs.showOpenDialog(window, {
      title: request.stage === 'tpose' ? 'Use an existing T-pose reference' : 'Use an existing 3D GLB mesh',
      properties: ['openFile'],
      filters: request.stage === 'model' ? [{ name: 'Embedded GLB mesh', extensions: ['glb'] }] : [{ name: 'Character image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    return result.canceled ? null : studio.designer.importStage(result.filePaths[0], request)
  })
  handle('designer:run', (id: string, stage: DesignStage) => studio.designer.run(id, stage))
  handle('designer:cancel', () => studio.designer.cancel())
  handle('designer:animate', (id: string) => studio.importDesign(id))
  handle('designer:reference', async () => {
    const result = await fileDialogs.showOpenDialog(window, { title: 'Choose a local character reference', properties: ['openFile'], filters: [{ name: 'Character image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    return result.canceled ? null : studio.designer.addReference(result.filePaths[0])
  })
  handle('designer:export', async (id: string, stage: DesignStage) => {
    const source = studio.designer.output(id, stage)
    const extension = stage === 'model' ? 'glb' : 'png'
    const choice = await fileDialogs.showSaveDialog(window, { defaultPath: `${studio.designer.title(id).replace(/[^a-zA-Z0-9 _-]/g, '_')}-${stage}.${extension}`, filters: [{ name: 'Design output', extensions: [extension] }] })
    if (choice.canceled || !choice.filePath) return null
    await copyFile(source, choice.filePath)
    return choice.filePath
  })
  handle('studio:settings', (settings: Settings) => studio.saveSettings(settings))
  handle('studio:browse', browse)
  handle('studio:import', async () => {
    const result = await fileDialogs.showOpenDialog(window, { title: 'Import humanoid FBX', properties: ['openFile'], filters: [{ name: 'FBX character', extensions: ['fbx'] }] })
    return result.canceled ? null : studio.importCharacter(result.filePaths[0])
  })
  handle('studio:import-collection', async () => {
    const result = await fileDialogs.showOpenDialog(window, { title: 'Import FBX collection', properties: ['openFile', 'multiSelections'], filters: [{ name: 'FBX characters', extensions: ['fbx'] }] })
    if (result.canceled) return []
    if (result.filePaths.length > 32) throw new Error('Import up to 32 FBXs per collection.')
    const characters = []
    for (const file of result.filePaths) characters.push(await studio.importCharacter(file))
    return characters
  })
  handle('studio:setup', (id: string, setup: RigSetup) => studio.saveSetup(id, setup))
  handle('studio:fit-landmarks', (id: unknown, rotation: unknown) => studio.fitLandmarks(z.string().uuid().parse(id), rotationSchema.parse(rotation)))
  handle('studio:rig', (id: string, skinning?: import('../shared/types').SkinningMode) => studio.rig(id, false, skinning))
  handle('studio:generate', (request: GenerateRequest) => studio.generate(request))
  handle('studio:cancel', () => studio.cancel())
  handle('studio:check', () => studio.check())
  handle('studio:start-comfy', () => studio.startComfy())
  handle('studio:save-output', async (jobId: string, file: string) => {
    const source = studio.output(jobId, file)
    const result = await fileDialogs.showSaveDialog(window, { defaultPath: file, filters: [{ name: extname(file).slice(1).toUpperCase(), extensions: [extname(file).slice(1)] }] })
    if (result.canceled || !result.filePath) return null
    await copyFile(source, result.filePath)
    return result.filePath
  })
  handle('studio:access-page', () => shell.openExternal('https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct'))
  handle('studio:token-settings', () => shell.openExternal('https://huggingface.co/settings/tokens'))
  handle('studio:reveal-data', () => shell.openPath(studio.root).then(error => { if (error) throw new Error(error) }))
  handle('studio:save-plan', (plan: MotionPlan) => studio.savePlan(plan))
  handle('studio:run-batch', (request: BatchRequest) => studio.runBatch(request))
  handle('studio:rerun-batch', (id: string) => studio.rerunBatch(id))
  handle('studio:export-batch', async (id: string) => {
    const choice = await fileDialogs.showOpenDialog(window, { title: 'Save completed batch outputs into a new subfolder', properties: ['openDirectory', 'createDirectory'] })
    return choice.canceled ? null : studio.exportBatch(id, choice.filePaths[0])
  })
  handle('studio:export-plan', async (id: string) => {
    const plan = studio.plan(id)
    const choice = await fileDialogs.showSaveDialog(window, { defaultPath: plan.name.replace(/[^a-zA-Z0-9 _-]/g, '_') + '.json', filters: [{ name: 'Motion configuration', extensions: ['json'] }] })
    if (choice.canceled || !choice.filePath) return null
    await writeFile(choice.filePath, JSON.stringify({ schemaVersion: 2, plan }, null, 2))
    return choice.filePath
  })
  handle('studio:import-plan', async () => {
    const choice = await fileDialogs.showOpenDialog(window, { title: 'Import saved motion configuration', properties: ['openFile'], filters: [{ name: 'Motion configuration', extensions: ['json'] }] })
    if (choice.canceled) return null
    if ((await stat(choice.filePaths[0])).size > 1024 * 1024) throw new Error('Configuration JSON exceeds 1 MB.')
    const data = JSON.parse(await readFile(choice.filePaths[0], 'utf8'))
    if (![1, 2].includes(data.schemaVersion)) throw new Error('Unsupported motion configuration version.')
    return studio.savePlan({ ...data.plan, id: randomUUID() })
  })
  if (allowedRenderer) await window.loadURL(allowedRenderer)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  await mcpControl.initialize(mcpRequested)
}).catch(error => { dialog.showErrorBox('Character Studio could not start', errorText(error)); app.exit(1) })

app.on('before-quit', event => {
  if (!quitting && studio) {
    event.preventDefault()
    quitting = true
    files?.cancel()
    Promise.all([mcp?.close(), studio.dispose()]).catch(error => dialog.showErrorBox('Backend shutdown needs attention', errorText(error))).finally(() => app.quit())
  }
})
app.on('window-all-closed', () => app.quit())
