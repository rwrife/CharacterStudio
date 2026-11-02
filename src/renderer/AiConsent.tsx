import { useEffect, useState } from 'react'
import type { AiConsent as Consent } from '../shared/ai'
import { aiModelLabel, aiStages } from '../shared/ai'

export function AiConsent() {
  const [request, setRequest] = useState<Consent | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => window.studio?.onAiConsent(value => { setRequest(value); setError(''); setBusy(false) }), [])
  if (!request) return null
  async function reply(approved: boolean) {
    setBusy(true)
    try { await window.studio.aiConsentReply(request!.id, approved) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false) }
  }
  return <div className="modal-backdrop ai-consent"><section className="settings-modal" role="dialog" aria-modal="true" aria-label="Approve remote AI execution">
    <span className="section-kicker">REMOTE EXECUTION / EXPLICIT OPT-IN</span>
    <h2>Send this stage to a remote provider?</h2>
    <p><strong>{aiStages[request.stage]}</strong> will send data to <strong>{request.endpoint}</strong>.</p>
    <p>Provider: {request.provider}. Model: {aiModelLabel(request) || 'Selected workflow / server default'}.</p>
    <ul>{request.inputs.map(input => <li key={input}>{input}</li>)}</ul>
    <p>This endpoint may process data using other services. Only approve an endpoint and workflow you trust.</p>
    <p><strong>{request.provider === 'tripo' ? 'Tripo is a paid service. API credits are separate from Tripo web subscriptions. ' : ''}Charges may apply. </strong>
      Cancelling stops Studio from waiting and attempts job-scoped cancellation where supported. Tripo tasks may continue and incur charges.</p>
    {request.endpoint.startsWith('http:') && <p role="alert">This connection is not encrypted. Prompts and assets will travel over HTTP; API keys are never sent over HTTP.</p>}
    <div className="settings-actions">
      <button className="secondary" autoFocus disabled={busy} onClick={() => void reply(false)}>Keep data local / cancel</button>
      <button className="primary" disabled={busy} onClick={() => void reply(true)}>Approve this remote stage</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section></div>
}
