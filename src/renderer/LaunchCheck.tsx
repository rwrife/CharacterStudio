import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, ListChecks, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { LaunchCheck as LaunchResult, SetupAction, SetupItem, SetupItemId, SetupState } from '../shared/setup'
import { explain, SetupRow, startAutomatic } from './SetupWizard'

type Phase = 'checking' | 'issues' | 'ready' | 'failed'

/**
 * Validates dependencies on launches that do not open the full checklist. A small status card is shown while checking;
 * problems open a prompt with one-click fixes. The check can be cancelled at any time.
 */
export function LaunchCheck({ onClose, onOpenChecklist }: { onClose: () => void; onOpenChecklist: () => void }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [issues, setIssues] = useState<SetupItem[]>()
  const [state, setState] = useState<SetupState>()
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const known = useRef<SetupItem[] | undefined>(undefined)
  const hadTask = useRef(false)
  const closed = useRef(false)
  const generation = useRef(0)

  async function check() {
    const id = ++generation.current
    const stale = () => closed.current || id !== generation.current
    setPhase('checking'); setNote(''); setError('')
    let result: LaunchResult
    try { result = await window.studio.setupLaunchCheck() } catch (e) {
      if (stale()) return
      setError(explain(e)); setPhase('failed'); return
    }
    if (stale()) return
    if (result.cancelled) {
      // Cancelling the first check simply dismisses it; cancelling a re-check keeps the last known problems.
      if (!known.current) close(); else { setNote('Check cancelled. Showing the previous results.'); setPhase('issues') }
      return
    }
    const hadIssues = !!known.current?.length
    known.current = result.issues
    setIssues(result.issues)
    try { const started = await startAutomatic(result.issues); if (started && !stale()) setState(started) } catch (e) { if (!stale()) setError(explain(e)) }
    setPhase(result.issues.length ? 'issues' : 'ready')
    if (!result.issues.length && !hadIssues) setTimeout(() => close(), 2500)
  }

  useEffect(() => {
    closed.current = false
    window.studio.setupState().then(setState).catch(() => undefined)
    const remove = window.studio.onSetupUpdate(next => {
      setState(next)
      if (next.task) hadTask.current = true
      else if (hadTask.current) { hadTask.current = false; void check() }
    })
    void check()
    return () => { remove(); closed.current = true; generation.current++; void window.studio.setupCancelLaunchCheck() }
  }, [])

  function close() {
    if (closed.current) return
    closed.current = true
    void window.studio.setupCancelLaunchCheck()
    onClose()
  }
  async function run(item: SetupItem, action: SetupAction) {
    setError('')
    try { setState(await window.studio.setupRun({ item: item.id, action: action.id, model: action.model })) } catch (e) { setError(explain(e)) }
  }
  async function ignore(ids: SetupItemId[]) {
    try {
      const next = await window.studio.setupPreferences({ ignoredAtLaunch: [...(state?.ignoredAtLaunch ?? []), ...ids] })
      setState(next)
      const remaining = (known.current ?? []).filter(item => !ids.includes(item.id))
      known.current = remaining
      setIssues(remaining)
      if (!remaining.length) close()
    } catch (e) { setError(explain(e)) }
  }

  const task = state?.task
  const checking = phase === 'checking'
  if (!issues && phase !== 'failed') {
    return <div className={`launch-check-card ${phase}`} role="status" aria-label="Dependency check">
      {checking ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
      <span>{checking ? 'Checking Blender, ComfyUI and models…' : 'All required dependencies are working.'}</span>
      {checking ? <button className="secondary" onClick={() => void window.studio.setupCancelLaunchCheck()}><X size={13} /> Cancel</button>
        : <button aria-label="Dismiss dependency check" onClick={close}><X size={14} /></button>}
    </div>
  }

  const designerIssues = issues?.filter(item => item.group === 'designer') ?? []
  return <div className="modal-backdrop"><section className="settings-modal setup-modal launch-check" role="dialog" aria-modal="true" aria-label="Dependency check">
    <div className="modal-heading"><div><span className="section-kicker">DEPENDENCY CHECK</span>
      <h2>{phase === 'ready' ? 'Everything is working again' : phase === 'failed' ? 'Dependencies could not be checked' : 'Some dependencies need attention'}</h2></div>
      <button aria-label="Close dependency check" onClick={close}><X size={20} /></button></div>
    <div className="setup-summary" aria-live="polite">
      {checking ? <><LoaderCircle className="spin" size={14} /><span>Re-checking dependencies…</span>
        <button className="secondary" onClick={() => void window.studio.setupCancelLaunchCheck()}><X size={13} /> Cancel check</button></>
        : <><span>{phase === 'ready' ? 'All required dependencies are working.' : phase === 'failed' ? 'Try again, or open the full setup checklist.' :
          `${issues?.length} item${issues?.length === 1 ? '' : 's'} could block Designer or Animator. Fix ${issues?.length === 1 ? 'it' : 'them'} now or continue anyway.`}</span>
          <button className="text-button" disabled={!!task} onClick={() => void check()}><RefreshCw size={13} /> Re-check</button></>}
    </div>
    {note && <p className="setup-result" role="status"><CircleAlert size={14} /><span>{note}</span></p>}
    {state?.result && !task && <p className={`setup-result ${state.result.ok ? 'ok' : ''}`} role="status">{state.result.ok ? <Check size={14} /> : <CircleAlert size={14} />}<span>{state.result.message}</span></p>}
    {error && <p className="modal-error" role="alert">{error}</p>}
    {phase !== 'ready' && !!issues?.length && <section className="setup-group" aria-label="Dependencies needing attention">
      {designerIssues.length > 1 && <div className="section-heading"><div><small>Only use Animator? You can stop launch warnings about Designer models.</small></div>
        <button className="text-button" disabled={!!task} onClick={() => void ignore(designerIssues.map(item => item.id))}>Don't warn about Designer models</button></div>}
      {issues.map(item => <SetupRow key={item.id} item={item} task={task?.item === item.id ? task : undefined} busy={!!task || checking}
        onAction={action => void run(item, action)} onCancel={() => void window.studio.setupCancel()}
        extra={<button className="text-button" disabled={!!task} title="Hide this warning at launch until it works again" onClick={() => void ignore([item.id])}>Don't warn at launch</button>} />)}
    </section>}
    <div className="setup-footer">
      <label className="setup-toggle"><input type="checkbox" checked={state?.checkOnLaunch ?? true} onChange={e => void window.studio.setupPreferences({ checkOnLaunch: e.target.checked }).then(setState).catch(err => setError(explain(err)))} /> Check dependencies at launch</label>
      <div className="setup-footer-actions">
        <button className="secondary" onClick={() => { close(); onOpenChecklist() }}><ListChecks size={15} /> Open setup checklist</button>
        <button className="primary" onClick={close}>{phase === 'ready' ? 'Continue' : 'Continue anyway'}</button>
      </div>
    </div>
    <p className="fine-print">A passing check confirms prerequisites were found, not that every model loads or generates on your GPU. Running tasks continue if you close this prompt.</p>
  </section></div>
}
