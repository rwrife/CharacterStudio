import { stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute } from 'node:path'
import type { FileDialogRequest } from '../shared/file-dialog'

export async function validateDialogPaths(request: FileDialogRequest, paths: string[], overwrite: boolean) {
  if (!paths.length || paths.length > (request.multiple ? 32 : 1)) throw new Error('Choose the required number of paths (up to 32 files).')
  for (const path of paths) {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Use absolute local paths.')
    const extension = extname(path).slice(1).toLowerCase()
    if (!request.directory && request.filters.length && !request.filters.some(filter => filter.extensions.some(ext => ext === '*' || ext.toLowerCase() === extension))) {
      throw new Error(`Choose a supported file type: ${request.filters.flatMap(f => f.extensions).join(', ')}.`)
    }
    if (request.kind === 'save') {
      const parent = await stat(dirname(path))
      if (!parent.isDirectory()) throw new Error('The destination folder must exist.')
      const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (existing && !existing.isFile()) throw new Error('The destination is not a regular file.')
      if (existing && !overwrite) throw new Error('The destination exists. Enable Replace existing file to overwrite it.')
    } else {
      const entry = await stat(path)
      if (request.directory ? !entry.isDirectory() : !entry.isFile()) throw new Error(request.directory ? 'Choose an existing folder.' : 'Choose an existing regular file.')
    }
  }
}
