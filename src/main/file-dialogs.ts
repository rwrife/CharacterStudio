import { dialog, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { FileDialogRequest } from '../shared/file-dialog'
import { validateDialogPaths } from './file-dialog-validation'

export class FileDialogs {
  private pending?: {
    request: FileDialogRequest
    options: OpenDialogOptions | SaveDialogOptions
    resolve: (paths: string[] | null) => void
  }
  constructor(private window: BrowserWindow, private controlled: boolean) {}
  setControlled(enabled: boolean) { this.controlled = enabled }

  private async request(kind: 'open' | 'save', options: OpenDialogOptions | SaveDialogOptions) {
    if (this.pending) throw new Error('Complete the current file dialog first.')
    const properties: readonly string[] = options.properties ?? []
    const request: FileDialogRequest = {
      id: randomUUID(), kind, title: options.title ?? (kind === 'open' ? 'Open local file' : 'Save local file'),
      directory: properties.includes('openDirectory'), multiple: properties.includes('multiSelections'),
      filters: options.filters ?? [], defaultPath: options.defaultPath ?? ''
    }
    return new Promise<string[] | null>(resolve => {
      this.pending = { request, options, resolve }
      this.window.webContents.send('studio:file-dialog', request)
    })
  }
  async showOpenDialog(window: BrowserWindow, options: OpenDialogOptions) {
    if (!this.controlled) return dialog.showOpenDialog(window, options)
    const paths = await this.request('open', options)
    return { canceled: paths === null, filePaths: paths ?? [] }
  }
  async showSaveDialog(window: BrowserWindow, options: SaveDialogOptions) {
    if (!this.controlled) return dialog.showSaveDialog(window, options)
    const paths = await this.request('save', options)
    return { canceled: paths === null, filePath: paths?.[0] }
  }
  async reply(id: string, paths: string[] | null, overwrite: boolean) {
    const pending = this.pending
    if (!pending || pending.request.id !== id) throw new Error('This file dialog is no longer active.')
    if (paths !== null) await validateDialogPaths(pending.request, paths, overwrite)
    if (this.pending !== pending) throw new Error('This file dialog was replaced.')
    this.pending = undefined
    this.window.webContents.send('studio:file-dialog', null)
    pending.resolve(paths?.map(path => resolve(path)) ?? null)
  }
  async browse(id: string) {
    const pending = this.pending
    if (!pending || pending.request.id !== id) throw new Error('This file dialog is no longer active.')
    if (pending.request.kind === 'open') {
      const choice = await dialog.showOpenDialog(this.window, pending.options as OpenDialogOptions)
      return choice.canceled ? null : choice.filePaths
    }
    const choice = await dialog.showSaveDialog(this.window, pending.options as SaveDialogOptions)
    return choice.canceled || !choice.filePath ? null : [choice.filePath]
  }
  cancel() {
    const pending = this.pending
    this.pending = undefined
    pending?.resolve(null)
  }
}
