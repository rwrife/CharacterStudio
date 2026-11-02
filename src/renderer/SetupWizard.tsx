import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, Check, Circle, CircleAlert, Download, ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { formatBytes, type SetupAction, type SetupGroup, type SetupItem, type SetupReport, type SetupState } from '../shared/setup'

export const explain = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')
const groups: { id: SetupGroup; title: string; detail: string }[] = [
  { id: 'core', title: 'Core requirements', detail: 'Local tools both workspaces rely on.' },
  { id: 'animator', title: 'Animator', detail: 'Motion generation with Kimodo inside ComfyUI.' },
  { id: 'designer', title: 'Designer models', detail: 'Pinned public weights, verified by SHA-256 and saved into ComfyUI/models.' },
  { id: 'optional', title: 'Optional', detail: 'Nice to have; nothing is blocked without it.' }
]
const external = new Set(['open-comfy-guide', 'open-kimodo-nodes', 'open-llama-access', 'open-model-license', 'open-ollama'])

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<SetupReport>()
  const [state, setState] = useState<SetupState>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')

  async function refresh() {
    setChecking(true)
    try { setReport(await window.studio.setupReport()) } catch (e) { setError(explain(e)) } finally { setChecking(false) }
  }
  useEffect(() => {
    window.studio.setupState().then(setState).catch(e => setError(explain(e)))
    const remove = window.studio.onSetupUpdate(next => {
      setState(next)
      if (!next.task) void refresh()
    })
    void refresh()
    return remove
  }, [])

  async function run(item: SetupItem | undefined, action: SetupAction) {
    setError('')
    try { setState(await window.studio.setupRun({ item: item?.id ?? 'system', action: action.id, model: action.model })) }
    catch (e) { setError(explain(e)) }
  }
  async function close() {
    try { await window.studio.setupPreferences({ completed: !!report && report.ready.designer && report.ready.animator }) } catch { /* Closing never depends on saving preferences. */ }
    onClose()
  }

  const task = state?.task
  const required = report?.items.filter(item => item.requiredFor.length) ?? []
  const complete = required.filter(item => item.status === 'done').length
  // Mismatched files ('warning') are only replaced from their own row, never in bulk.
  const missingModels = report?.items.filter(item => item.group === 'designer' && item.status === 'todo') ?? []
  const missingBytes = missingModels.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
  const comfyChosen = report?.items.find(item => item.id === 'comfy-install')?.status === 'done'

  return <div className="modal-backdrop"><section className="settings-modal setup-modal" role="dialog" aria-modal="true" aria-label="Setup checklist">
    <div className="modal-heading"><div><span className="section-kicker">{state?.firstLaunch ? 'WELCOME · FIRST LAUNCH' : 'SETUP CHECKLIST'}</span><h2>Get Character Studio ready</h2></div><button aria-label="Close setup checklist" onClick={() => void close()}><X size={20} /></button></div>
    <p className="panel-description">Studio checked this PC for what Designer and Animator need. Everything runs locally; downloads come only from the pinned sources shown and are verified before use. Nothing here asks for passwords or tokens.</p>
    <div className="setup-summary" aria-live="polite">
      <div className="setup-meter"><span style={{ width: `${required.length ? (complete / required.length) * 100 : 0}%` }} /></div>
      <span>{report ? `${complete} of ${required.length} required steps complete` : 'Checking this PC…'}</span>
      {report && <><span className={`setup-pill ${report.ready.designer ? 'ready' : ''}`}>{report.ready.designer ? <Check size={12} /> : <Circle size={12} />} Designer</span>
        <span className={`setup-pill ${report.ready.animator ? 'ready' : ''}`}>{report.ready.animator ? <Check size={12} /> : <Circle size={12} />} Animator</span></>}
      <button className="text-button" disabled={checking || !!task} onClick={() => void refresh()}><RefreshCw size={13} className={checking ? 'spin' : ''} /> Re-check</button>
    </div>
    {state?.result && !task && <p className={`setup-result ${state.result.ok ? 'ok' : ''}`} role="status">{state.result.ok ? <Check size={14} /> : <CircleAlert size={14} />}<span>{state.result.message}</span></p>}
    {error && <p className="modal-error" role="alert">{error}</p>}
    {!report && <div className="setup-loading"><LoaderCircle className="spin" size={18} /> Detecting Blender, ComfyUI, models and GPU…</div>}
    {report && groups.map(group => {
      const items = report.items.filter(item => item.group === group.id)
      return <section className="setup-group" key={group.id} aria-label={group.title}>
        <div className="section-heading"><div><span className="section-kicker">{group.title}</span><small>{group.detail}</small></div>
          {group.id === 'designer' && missingModels.length > 1 && <button className="secondary" disabled={!!task || !comfyChosen} title={comfyChosen ? undefined : 'Choose a ComfyUI folder first.'} onClick={() => void run(undefined, { id: 'download-model', label: 'Download all' })}><Download size={14} /> Download all missing · {formatBytes(missingBytes)}</button>}
        </div>
        {group.id === 'designer' && task?.item === 'system' && <div className="setup-task"><LoaderCircle className="spin" size={14} /><div className="setup-progress"><div className="progress-track"><span style={{ width: `${Math.round((task.fraction ?? 0) * 100)}%` }} /></div><small>{task.message}</small></div><button className="secondary" onClick={() => void window.studio.setupCancel()}><X size={13} /> Cancel</button></div>}
        {items.map(item => <SetupRow key={item.id} item={item} task={task?.item === item.id ? task : undefined} busy={!!task}
          onAction={action => void run(item, action)} onCancel={() => void window.studio.setupCancel()} />)}
      </section>
    })}
    <div className="setup-footer">
      <div className="setup-toggles">
        <label className="setup-toggle"><input type="checkbox" checked={state?.showOnLaunch ?? false} onChange={e => void window.studio.setupPreferences({ showOnLaunch: e.target.checked }).then(setState).catch(err => setError(explain(err)))} /> Show this checklist at launch</label>
        <label className="setup-toggle"><input type="checkbox" checked={state?.checkOnLaunch ?? true} onChange={e => void window.studio.setupPreferences({ checkOnLaunch: e.target.checked }).then(setState).catch(err => setError(explain(err)))} /> Otherwise, check dependencies at launch</label>
      </div>
      <button className="primary" onClick={() => void close()}>{report?.ready.designer && report.ready.animator ? 'Start creating' : 'Continue to Studio'} <ArrowRight size={15} /></button>
    </div>
    <p className="fine-print">You can reopen this checklist from the <strong>Setup checklist</strong> button (task-list icon) in the top bar. Readiness here is a setup check, not proof that every model loads or generates on your GPU; each stage still validates its inputs when it runs. Model licenses are set by their publishers—review them before commercial use.</p>
  </section></div>
}

export function SetupRow({ item, task, busy, onAction, onCancel, extra }: { item: SetupItem; task?: SetupState['task']; busy: boolean; onAction: (action: SetupAction) => void; onCancel: () => void; extra?: ReactNode }) {
  const icon = item.status === 'done' ? <Check size={16} /> : item.status === 'optional' ? <Circle size={16} /> : <CircleAlert size={16} />
  return <div className={`setup-item ${item.status}`} data-item={item.id}>
    <span className="setup-icon" aria-label={item.status === 'done' ? 'Done' : item.status === 'optional' ? 'Optional' : 'Needs action'}>{icon}</span>
    <div className="setup-body">
      <strong>{item.title}{item.requiredFor.length > 0 && item.status !== 'done' && <small>needed for {item.requiredFor.join(' & ')}</small>}</strong>
      <p>{item.detail}</p>
      {task && <div className="setup-progress"><div className="progress-track"><span style={{ width: `${Math.round((task.fraction ?? 0) * 100)}%` }} className={task.fraction === undefined ? 'indeterminate' : ''} /></div><small>{task.message}</small></div>}
    </div>
    <div className="setup-actions">
      {task ? <button className="secondary" onClick={onCancel}><X size={13} /> Cancel</button> :
        item.actions.map(action => <button key={action.id + (action.model ?? '')} className={action.primary ? 'primary' : 'secondary'} disabled={(busy && !external.has(action.id)) || !!action.disabled} title={action.disabled} onClick={() => onAction(action)}>
          {action.label}{external.has(action.id) && <ExternalLink size={12} />}
        </button>)}
      {!task && extra}
    </div>
  </div>
}
