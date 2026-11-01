import { useEffect, useState } from 'react'
import type { FileDialogRequest } from '../shared/file-dialog'

export function FileDialog() {
  const [request, setRequest] = useState<FileDialogRequest | null>(null)
  const [paths, setPaths] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => window.studio?.onFileDialog(value => {
    setRequest(value); setPaths(value?.defaultPath ?? ''); setOverwrite(false); setError(''); setBusy(false)
  }), [])
  if (!request) return null
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  return <div className="modal-backdrop" style={{ zIndex: 1000 }}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-label={request.title}>
      <h2>{request.title}</h2>
      <p className="panel-description">Desktop MCP control is enabled. Choose paths here so both you and the agent can see the file selection. Files stay local.</p>
      <label className="field-label" htmlFor="desktop-file-paths">{request.directory ? 'Absolute folder path' : request.multiple ? 'Absolute file paths (one per line)' : 'Absolute file path'}</label>
      <textarea id="desktop-file-paths" autoFocus rows={request.multiple ? 5 : 2} value={paths} disabled={busy} onChange={event => setPaths(event.target.value)} />
      {request.filters.length > 0 && <p className="fine-print">Supported: {request.filters.map(filter => `${filter.name} (${filter.extensions.join(', ')})`).join('; ')}</p>}
      {request.kind === 'save' && <label className="checkbox"><input type="checkbox" checked={overwrite} disabled={busy} onChange={event => setOverwrite(event.target.checked)} /> Replace existing file</label>}
      {error && <div className="banner error" role="alert">{error}</div>}
      <div className="node-actions">
        <button className="secondary" disabled={busy} onClick={() => void run(async () => {
          const selected = await window.studio.fileDialogBrowse(request.id)
          if (selected) setPaths(selected.join('\n'))
        })}>Browse on this PC</button>
        <button className="secondary" disabled={busy} onClick={() => void run(() => window.studio.fileDialogReply(request.id, null, false))}>Cancel file selection</button>
        <button className="primary" disabled={busy || !paths.trim()} onClick={() => void run(() =>
          window.studio.fileDialogReply(request.id, paths.split(/\r?\n/).map(path => path.trim()).filter(Boolean), overwrite)
        )}>{request.kind === 'save' ? 'Save selected file' : 'Use selected paths'}</button>
      </div>
    </section>
  </div>
}
