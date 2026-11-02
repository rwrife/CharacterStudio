import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Check, RefreshCw, X } from 'lucide-react'
import { aiConfigurationSchema, aiModelLabel, aiRouteLabel, aiStages, aiStageSchema, defaultAiConfiguration, localRoute, resolveAiRoute, tripoCredentialEndpoints, tripoImageModelId, tripoImageModels, tripoMeshLimits, unavailableTripoImageModels, workflowSchema,
  type AiConfiguration, type AiHardware, type AiRoute, type AiStage, type TripoCredentialTarget } from '../shared/ai'
import { imageProfiles, meshProfiles, tposeEditProfile, type DesignerReadiness } from '../shared/designer'
import type { Check as BackendCheck, Snapshot } from '../shared/types'
import { mergeSettingsDraft } from '../shared/workspace'
import { NativeModelFields } from './NativeModelFields'
import { ModelSetupGuide } from './ModelSetupGuide'
import { useModalSurface } from './useModalSurface'
import { recommendTextEncoder } from '../shared/text-encoder'
import './ai.css'

const choices: Record<string, { label: string; provider: AiRoute['provider']; location: AiRoute['location']; endpoint: string }> = {
  builtin: { label: 'Built-in local presets', provider: 'builtin', location: 'local', endpoint: '' },
  'local-comfyui': { label: 'Local ComfyUI / custom workflow', provider: 'comfyui', location: 'local', endpoint: 'http://127.0.0.1:8189' },
  'remote-comfyui': { label: 'Remote ComfyUI (opt-in)', provider: 'comfyui', location: 'remote', endpoint: 'https://' },
  'local-api': { label: 'Local Studio API gateway', provider: 'api', location: 'local', endpoint: 'http://127.0.0.1:8000' },
  'remote-api': { label: 'Remote Studio API gateway (opt-in)', provider: 'api', location: 'remote', endpoint: 'https://' },
  tripo: { label: 'Tripo v3 (remote / paid API credits)', provider: 'tripo', location: 'remote', endpoint: tripoCredentialEndpoints.tripo }
}
const future = new Set<AiStage>(['segmentation', 'landmarks', 'cloth'])
const explain = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')

function TripoKeySetup({ target, disabled, onBusy, onDraftChange }: {
  target?: TripoCredentialTarget; disabled: boolean; onBusy: (busy: boolean) => void; onDraftChange: (dirty: boolean) => void
}) {
  const [secret, setSecret] = useState('')
  const [hasSecret, setHasSecret] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => onDraftChange(!!secret), [secret, onDraftChange])
  useEffect(() => {
    let current = true
    setSecret(''); setHasSecret(false); setError(''); setNotice(''); setLoading(!!target)
    if (target) void window.studio.aiCredentialStatus(target)
      .then(value => { if (current) setHasSecret(value) })
      .catch(error => { if (current) setError(explain(error)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [target])
  async function perform(work: (target: TripoCredentialTarget) => Promise<void>) {
    if (!target) { setError('Use an official Tripo endpoint before saving a key.'); return }
    onBusy(true); setError(''); setNotice('')
    try { await work(target) } catch (error) { setError(explain(error)) } finally { onBusy(false) }
  }
  return <section className="ai-key-setup" aria-label="Tripo API key setup">
    <h3>Tripo API key</h3>
    <p className="fine-print">Tripo is the default key provider. Paste your key now; you do not need to choose or save a generation provider first. Saving a key does not enable remote generation.</p>
    {target ? <p className="fine-print">Key endpoint: <strong>{tripoCredentialEndpoints[target]}</strong></p> :
      <p role="alert">Use Tripo's official HTTPS .ai or .com endpoint in the provider settings below.</p>}
    <label className="field-label" htmlFor="ai-tripo-secret">Tripo API key / token <span>OS-encrypted</span></label>
    <input id="ai-tripo-secret" type="password" autoComplete="off" spellCheck={false} maxLength={8192}
      disabled={disabled || !target} value={secret} onChange={event => setSecret(event.target.value)} />
    <p className="fine-print" role="status">{loading ? 'Checking saved Tripo key...' :
      hasSecret ? 'An encrypted Tripo API key is saved for this endpoint. Its value is never returned.' : 'No Tripo API key saved for this endpoint.'}</p>
    <div className="settings-actions">
      <button className="primary" disabled={disabled || loading || !target || !secret.trim()} onClick={() => void perform(async target => {
        await window.studio.aiCredential(target, secret)
        setSecret(''); setHasSecret(true); setNotice('Tripo API key encrypted using OS-backed storage. Generation selections are unchanged.')
      })}>Save Tripo API key</button>
      <button className="secondary" disabled={disabled || loading || !target || !hasSecret} onClick={() => void perform(async target => {
        await window.studio.aiCredential(target, '')
        setSecret(''); setHasSecret(false); setNotice('Tripo API key removed.')
      })}>Remove Tripo API key</button>
      <button className="secondary" disabled={disabled || loading || !target || !hasSecret} onClick={() => void perform(async target => {
        const balance = await window.studio.aiBalance(target)
        setNotice(`Tripo API credit balance: ${balance.balance}; frozen: ${balance.frozen}. Generation is a paid option.`)
      })}>Check Tripo API credits</button>
    </div>
    <p className="fine-print">Tripo is a paid service with separate API credits. Your key is stored only in the machine's encrypted vault, not in project settings.</p>
    {error && <p className="modal-error" role="alert">{error}</p>}
    {notice && <p className="banner success" role="status">{notice}</p>}
  </section>
}

export function AiProvidersPanel({ snapshot, initialStage = 'scene', initialField, locked, onClose }: {
  snapshot: Snapshot; initialStage?: AiStage; initialField?: string; locked: boolean; onClose: () => void
}) {
  const baseline = useRef(snapshot)
  const dialog = useRef<HTMLElement>(null)
  const [config, setConfig] = useState<AiConfiguration>(snapshot.ai ?? defaultAiConfiguration)
  const [stage, setStage] = useState<AiStage | 'global'>(initialStage)
  const [hardware, setHardware] = useState<AiHardware>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [secret, setSecret] = useState('')
  const [hasSecret, setHasSecret] = useState(false)
  const [customTripoModel, setCustomTripoModel] = useState(false)
  const [workflowText, setWorkflowText] = useState(() => {
    const workflow = resolveAiRoute(snapshot.ai, initialStage).workflow
    return workflow ? JSON.stringify(workflow, null, 2) : ''
  })
  const [native, setNative] = useState(snapshot.designer?.config)
  const [encoder, setEncoder] = useState(snapshot.settings.textEncoder ?? 'llm2vec')
  const [ready, setReady] = useState<DesignerReadiness>()
  const [catalogError, setCatalogError] = useState('')
  const [checkingModels, setCheckingModels] = useState(false)
  const [modelChecks, setModelChecks] = useState<BackendCheck[]>([])
  const [confirmClose, setConfirmClose] = useState(false)
  const [keyDirty, setKeyDirty] = useState(false)
  const ownRoute = stage === 'global' ? config.globalComfy : config.stages[stage]
  const route = stage === 'global' ? config.globalComfy ?? localRoute : resolveAiRoute(config, stage)
  const inherited = stage !== 'global' && !ownRoute
  const selected = inherited ? 'inherit' : route.provider === 'builtin' ? 'builtin' : route.provider === 'tripo' ? 'tripo' : `${route.location}-${route.provider}`
  const dirty = JSON.stringify(config) !== JSON.stringify(baseline.current.ai ?? defaultAiConfiguration) ||
    workflowText !== (route.workflow ? JSON.stringify(route.workflow, null, 2) : '') ||
    JSON.stringify(native) !== JSON.stringify(baseline.current.designer?.config) || encoder !== (baseline.current.settings.textEncoder ?? 'llm2vec')
  const disabled = locked || busy
  const tripoImage = route.provider === 'tripo' && ['scene', 'tpose'].includes(stage)
  const tripoModel = tripoImageModelId(route.model)
  const customModel = tripoImage && (customTripoModel || !Object.hasOwn(tripoImageModels, tripoModel))
  const meshLimits = tripoMeshLimits(route.model, route.tripoMesh?.smartLowPoly)
  const tripoEndpoint = route.provider === 'tripo' ? route.endpoint.replace(/\/+$/, '') : tripoCredentialEndpoints.tripo
  const tripoTarget = tripoEndpoint === tripoCredentialEndpoints.tripo ? 'tripo' :
    tripoEndpoint === tripoCredentialEndpoints['tripo-com'] ? 'tripo-com' : undefined
  const free = Math.max(0, ...(hardware?.devices.map(device => device.freeGB) ?? []))
  const encoderGpu = modelChecks.find(check => check.gpu)?.gpu
  const encoderAdvice = recommendTextEncoder(encoderGpu)
  function requestClose() {
    if (busy) return
    if (dirty || secret || keyDirty) setConfirmClose(true)
    else onClose()
  }
  useModalSurface(dialog, requestClose)
  async function refreshModels() {
    setCheckingModels(true); setCatalogError('')
    try {
      if (stage === 'motion') setModelChecks(await window.studio.check())
      else setReady(await window.studio.designerReadiness())
    } catch (error) { setCatalogError(explain(error)) } finally { setCheckingModels(false) }
  }
  useEffect(() => { if (route.provider === 'builtin') void refreshModels() }, [stage, route.provider])
  useEffect(() => {
    if (initialField) dialog.current?.querySelector<HTMLElement>(`#${initialField}`)?.focus()
  }, [initialField])
  async function perform(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (error) { setError(explain(error)) } finally { setBusy(false) }
  }
  useEffect(() => { void window.studio.aiHardware().then(setHardware).catch(error => setError(explain(error))) }, [])
  useEffect(() => {
    let current = true
    setSecret(''); setHasSecret(false)
    void window.studio.aiCredentialStatus(stage).then(value => { if (current) setHasSecret(value) })
      .catch(error => { if (current && route.provider !== 'builtin') setError(explain(error)) })
    return () => { current = false }
  }, [stage, snapshot.ai])
  function changeRoute(next?: AiRoute) {
    if (stage === 'global') setConfig({ ...config, globalComfy: next })
    else {
      const stages = { ...config.stages }
      if (next) stages[stage] = next
      else delete stages[stage]
      setConfig({ ...config, stages })
    }
  }
  function switchStage(value: string) {
    const next = value === 'global' ? 'global' : aiStageSchema.parse(value)
    setStage(next); setError(''); setNotice(''); setCustomTripoModel(false)
    const workflow = next === 'global' ? config.globalComfy?.workflow : resolveAiRoute(config, next).workflow
    setWorkflowText(workflow ? JSON.stringify(workflow, null, 2) : '')
  }
  function changeTripoMesh(next: NonNullable<AiRoute['tripoMesh']>) {
    const nextRoute = { ...route }
    if (next.maxTriangles !== undefined || next.smartLowPoly) nextRoute.tripoMesh = next
    else delete nextRoute.tripoMesh
    changeRoute(nextRoute)
  }
  function choice(value: string) {
    setWorkflowText(''); setSecret(''); setCustomTripoModel(false)
    if (value === 'inherit') { changeRoute(); return }
    if (stage === 'global' && value === 'builtin') { changeRoute(); return }
    const item = choices[value]
    if (!item) return
    const model = item.provider === 'tripo' ? stage === 'mesh' ? 'v3.1-20260211' : stage === 'rig' ? 'v1.0-20240301' : stage === 'texture' ? 'v3.5-20260815' : 'banana' : ''
    changeRoute({ provider: item.provider, location: item.location,
      endpoint: item.provider === 'comfyui' && item.location === 'local' ? snapshot.settings.comfyUrl : item.endpoint,
      model, minVramGB: 0 })
  }
  async function save() {
    let next = config
    if (stage !== 'global' && route.provider === 'comfyui' && !inherited) {
      const workflow = workflowText.trim() ? workflowSchema.parse(JSON.parse(workflowText)) : undefined
      next = { ...config, stages: { ...config.stages, [stage]: { ...route, workflow } } }
    }
    const latest = await window.studio.snapshot()
    const { stages: baseStages, ...baseGlobal } = baseline.current.ai ?? defaultAiConfiguration
    const { stages: draftStages, ...draftGlobal } = next
    const { stages: currentStages, ...currentGlobal } = latest.ai ?? defaultAiConfiguration
    next = aiConfigurationSchema.parse({
      ...mergeSettingsDraft(baseGlobal, draftGlobal, currentGlobal),
      stages: mergeSettingsDraft(baseStages, draftStages, currentStages)
    })
    const nextNative = native && baseline.current.designer && latest.designer ?
      mergeSettingsDraft(baseline.current.designer.config, native, latest.designer.config) : native
    const nextSettings = mergeSettingsDraft(
      { textEncoder: baseline.current.settings.textEncoder ?? 'llm2vec' },
      { textEncoder: encoder }, { textEncoder: latest.settings.textEncoder ?? 'llm2vec' })
    if (nextNative && JSON.stringify(nextNative) !== JSON.stringify(latest.designer?.config)) await window.studio.designerSettings(nextNative)
    if (nextSettings.textEncoder !== (latest.settings.textEncoder ?? 'llm2vec')) await window.studio.settings({ ...latest.settings, ...nextSettings })
    await window.studio.aiSettings(next)
    baseline.current = await window.studio.snapshot()
    setNative(baseline.current.designer?.config)
    setEncoder(baseline.current.settings.textEncoder ?? 'llm2vec')
    setConfig(next)
    const workflow = stage === 'global' ? undefined : resolveAiRoute(next, stage).workflow
    setWorkflowText(workflow ? JSON.stringify(workflow, null, 2) : '')
    setNotice('Provider selections saved. Existing jobs keep their original provenance; remote generation still requires approval.')
  }
  const budgetText = (gb: number) => hardware?.devices.length ? free >= gb ? 'Recommended for available VRAM' : 'Not enough free VRAM' : 'VRAM not detected'
  return <div className="modal-backdrop model-settings-backdrop"><section ref={dialog} tabIndex={-1} className="settings-modal ai-modal model-settings" role="dialog" aria-modal="true" aria-label="Model Settings">
    <div className="modal-heading"><div><span className="section-kicker">LOCAL FIRST / PER-STAGE CONTROL</span><h2>Model Settings</h2></div>
      <button aria-label="Close Model Settings" disabled={busy} onClick={requestClose}><X size={20} /></button></div>
    {confirmClose && <section className="model-close-confirm" role="alert" aria-label="Unsaved model settings">
      <p>You have unsaved settings or credential input. Save settings first, discard the draft, or continue editing. Saving settings does not save an unsubmitted key.</p>
      <div className="settings-actions">
        <button className="secondary" disabled={busy} onClick={() => setConfirmClose(false)}>Continue editing</button>
        <button className="secondary" disabled={busy} onClick={onClose}>Discard changes</button>
        <button className="primary" disabled={disabled || !dirty} onClick={() => void perform(async () => { await save(); setConfirmClose(false) })}>Save settings</button>
      </div>
      {error && <p className="modal-error" role="alert">{error}</p>}
    </section>}
    <div className="model-settings-content" role="region" aria-label="Model Settings content" inert={confirmClose}>
    <p className="panel-description">Choose hardware-fit local presets or opt in to a remote server. No model is switched automatically and no generation starts when you save.</p>
    <details className="model-advanced"><summary>API keys & connections</summary>
      <TripoKeySetup target={tripoTarget} disabled={disabled} onBusy={setBusy} onDraftChange={setKeyDirty} />
    </details>
    <details className="ai-hardware"><summary>Hardware guidance</summary><div aria-label="Local hardware">
      <div className="section-heading"><strong>This machine</strong><button className="text-button" disabled={disabled} onClick={() => void perform(async () => setHardware(await window.studio.aiHardware()))}><RefreshCw size={14} /> Detect local hardware</button></div>
      {hardware ? <><p>{hardware.platform} / {hardware.architecture} / {hardware.cpu}</p><p>{hardware.freeRamGB.toFixed(1)} GiB free / {hardware.ramGB.toFixed(1)} GiB system RAM</p>
        {hardware.devices.map((device, index) => <p key={index}>{device.name}: {device.freeGB.toFixed(1)} GiB free / {device.totalGB.toFixed(1)} GiB total VRAM</p>)}
        {hardware.warning && <p>{hardware.warning}</p>}</> : <p>Detecting local hardware...</p>}
      <p className="fine-print">Memory estimates are guidance, not guarantees. GPU architecture, drivers, precision and shared memory still matter.</p>
    </div></details>
    <label className="field-label" htmlFor="ai-stage">AI stage</label>
    <select id="ai-stage" value={stage} disabled={disabled || workflowText !== (route.workflow ? JSON.stringify(route.workflow, null, 2) : '')} onChange={event => switchStage(event.target.value)}>
      <option value="global">Global ComfyUI connection</option>
      {Object.entries(aiStages).map(([value, label]) => <option key={value} value={value} disabled={future.has(aiStageSchema.parse(value))}>{label}</option>)}
    </select>
    <p className="fine-print">Global ComfyUI applies to scene, T-pose, cutout, mesh and motion unless overridden. Naming, post-texturing, remote rigging and Mocap video pose capture are independent. Segmentation, landmark AI and cloth AI are not yet implemented.</p>
    <label className="field-label" htmlFor="ai-provider">Execution provider</label>
    <select id="ai-provider" disabled={disabled} value={selected} onChange={event => choice(event.target.value)}>
      {stage !== 'global' && <option value="inherit">{stage === 'capture' ? 'Use default (built-in MediaPipe in Mocap)' : 'Use default / global ComfyUI connection'}</option>}
      {Object.entries(choices).filter(([key, item]) => stage !== 'global' || ['builtin', 'local-comfyui', 'remote-comfyui'].includes(key))
        .filter(([, item]) => item.provider !== 'tripo' || ['scene', 'tpose', 'mesh', 'texture', 'rig'].includes(stage))
        .map(([value, item]) => <option key={value} value={value}>{stage === 'global' && value === 'builtin' ? 'No global override (local defaults)' : item.label}</option>)}
    </select>
    <p className={`ai-route-badge ${route.location}`} role="status">{stage === 'global' ? `${route.location === 'remote' ? 'Remote' : 'Local'} / global connection` : aiRouteLabel(config, stage)}</p>
    {inherited && <p className="fine-print">This stage inherits its default. Select a provider above to override it independently.</p>}
    {route.provider !== 'builtin' && <>
      <label className="field-label" htmlFor="ai-endpoint">Provider endpoint <span>no key in URL</span></label>
      <input id="ai-endpoint" disabled={disabled || inherited} maxLength={2048} value={route.endpoint} onChange={event => changeRoute({ ...route, endpoint: event.target.value })} />
      {stage !== 'global' && <>
        {tripoImage && <>
          <label className="field-label" htmlFor="ai-tripo-image">Tripo image model</label>
          <select id="ai-tripo-image" disabled={disabled || inherited} value={customModel ? 'custom' : tripoModel} onChange={event => {
            setCustomTripoModel(event.target.value === 'custom')
            if (event.target.value !== 'custom') changeRoute({ ...route, model: event.target.value })
          }}>
            {Object.entries(tripoImageModels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            <option value="custom">Custom model ID (advanced)</option>
          </select>
          <p className="fine-print">{unavailableTripoImageModels.some(model => model === tripoModel) ?
            'This legacy image preset is not supported by Tripo v3. Choose a supported preset or configure a compatible Studio API gateway. ' :
            tripoModel === 'seedream_v4' ? 'Seedream v4 cannot use a reference image or edit a scene into a T-pose. ' :
            customModel ? 'Use a Tripo-supported image model ID; reference-image support depends on that model. ' :
              `${aiModelLabel(route)} supports text prompts and reference-image editing. `}Tripo image prompts are limited to 1,024 characters.</p>
          {tripoModel === 'chat_image_1' && <p className="ai-warning">Tripo lists GPT Image 1 as retired. This legacy selection is preserved for migration; availability is account-dependent. Choose a supported model for new work.</p>}
          {tripoModel === 'chat_image_1.5' && <p className="fine-print">Tripo schedules GPT Image 1.5 retirement for December 1, 2026. Studio will not switch your model automatically.</p>}
        </>}
        {(!tripoImage || customModel) && <>
          <label className="field-label" htmlFor="ai-model">Provider model / checkpoint ID</label>
          <input id="ai-model" disabled={disabled || inherited} maxLength={200} value={route.model} onChange={event => changeRoute({ ...route, model: event.target.value })} />
          <p className="fine-print">{route.provider === 'comfyui' ?
            'Use installed checkpoint names (including subfolders); changing architectures may require a custom template.' :
            'Use a model ID your provider actually supports.'}</p>
        </>}
      </>}
      {route.provider === 'tripo' && stage === 'mesh' && <section className="ai-mesh-settings" aria-label="Tripo mesh settings">
        <h3>Triangle reduction</h3>
        <label className="field-label" htmlFor="ai-tripo-triangles">Maximum triangles</label>
        <input id="ai-tripo-triangles" type="number" min={meshLimits.min} max={meshLimits.max} step={1}
          aria-describedby="ai-tripo-triangles-help" disabled={disabled || inherited}
          placeholder="Automatic (Tripo default)" value={route.tripoMesh?.maxTriangles ?? ''}
          onChange={event => changeTripoMesh({ ...route.tripoMesh, maxTriangles: event.target.value === '' ? undefined : event.target.valueAsNumber })} />
        <button className="text-button" disabled={disabled || inherited || route.tripoMesh?.maxTriangles === undefined}
          onClick={() => changeTripoMesh({ ...route.tripoMesh, maxTriangles: undefined })}>Use automatic triangle count</button>
        <p className="fine-print" id="ai-tripo-triangles-help">Leave blank for automatic density. Enter {meshLimits.min.toLocaleString('en-US')}-{meshLimits.max.toLocaleString('en-US')} triangles.
          This is a maximum, not an exact target. Custom models may impose stricter limits.</p>
        <label className="checkbox"><input type="checkbox" checked={route.tripoMesh?.smartLowPoly ?? false} disabled={disabled || inherited}
          onChange={event => changeTripoMesh({ ...route.tripoMesh, smartLowPoly: event.target.checked || undefined })} /> Smart low-poly</label>
        <p className="fine-print">Generate simplified topology for simpler shapes. With a triangle budget, use 500-20,000.
          Complex characters may fail or lose detail. {meshLimits.smartLowPolySupported ? '' : 'Not supported by this model; use H3 v3.0/v3.1 or leave it off.'}</p>
        <p className="fine-print">Applies to new 3D generations, not existing meshes. Output stays triangular GLB; no quad/FBX conversion is enabled.</p>
      </section>}
      {route.provider === 'tripo' && <div className="ai-warning"><strong>Paid Tripo API credits</strong><p>Use your own Tripo API key or token. API credit balance is separate from web subscriptions. Tripo hosts the image models above; its H3 v3.1 mesh model is not a verified Tencent Hunyuan 3.1 integration. Check current availability and prices in your Tripo account. No API key is included.</p></div>}
      {route.provider === 'api' && <p className="ai-warning">This endpoint must implement the documented Studio API gateway v1 contract, not an arbitrary vendor REST API. A gateway can route to Nano Banana, GPT Image, Midjourney or Hunyuan 3.1 using the model ID above. These are not bundled vendor integrations.</p>}
      {route.provider === 'comfyui' && stage !== 'global' && !inherited && <>
        <label className="field-label" htmlFor="ai-vram">Estimated free VRAM requirement (GiB)</label>
        <input id="ai-vram" type="number" min={0} max={192} step={0.5} disabled={disabled} value={route.minVramGB} onChange={event => changeRoute({ ...route, minVramGB: Number(event.target.value) })} />
        <p className="fine-print">0 uses a Designer native preset estimate; custom workflows and routed motion have no automatic estimate. Remote jobs never require local VRAM. {route.location === 'local' && route.minVramGB > 0 && `Local guidance: ${budgetText(route.minVramGB)}.`}</p>
        <div className="section-heading"><label className="field-label" htmlFor="ai-workflow">Custom workflow JSON & parameter mappings</label>
          <button className="text-button" disabled={disabled} onClick={() => void perform(async () => {
            const workflow = await window.studio.aiImportWorkflow()
            if (workflow) { changeRoute({ ...route, workflow }); setWorkflowText(JSON.stringify(workflow, null, 2)); setNotice('Workflow imported. Review its mappings and save before generating.') }
          })}><ArrowDownToLine size={14} /> Import workflow JSON</button></div>
        <textarea id="ai-workflow" className="ai-code" rows={6} maxLength={1024 * 1024} disabled={disabled} value={workflowText} onChange={event => setWorkflowText(event.target.value)} placeholder="Optional for native image/3D workflows. Paste a Studio workflow envelope: version, prompt, bindings, outputs." />
        <p className="fine-print">Use ComfyUI API-format nodes wrapped with the bindings and output mappings documented in README. No JavaScript or shell mapping. Do not put credentials in JSON. Native routed motion requires the supplied studio_provider_nodes extension on that server; custom motion must return SOMA-77 NPZ/BVH + metadata and accept inline constraints.</p>
      </>}
      {route.provider !== 'tripo' && <><div className="panel-rule" />
      <label className="field-label" htmlFor="ai-secret">API key / bearer token <span>OS-encrypted</span></label>
      <input id="ai-secret" type="password" autoComplete="off" spellCheck={false} maxLength={8192} disabled={disabled || dirty || inherited} value={secret} onChange={event => setSecret(event.target.value)} />
      <p className="fine-print">{dirty ? 'Save the endpoint first to bind this credential to that exact provider.' : hasSecret ? 'An encrypted credential is saved for this endpoint. Its value is never returned.' : 'No credential saved for this endpoint.'} HTTPS is required for keys. A changed endpoint never inherits a key from another endpoint.</p>
      <div className="settings-actions">
        <button className="secondary" disabled={disabled || dirty || inherited || !secret.trim()} onClick={() => void perform(async () => {
          await window.studio.aiCredential(stage, secret); setSecret(''); setHasSecret(true); setNotice('API credential encrypted using OS-backed storage.')
        })}>Save encrypted credential</button>
        <button className="secondary" disabled={disabled || dirty || inherited || !hasSecret} onClick={() => void perform(async () => {
          await window.studio.aiCredential(stage, ''); setSecret(''); setHasSecret(false); setNotice('Credential removed.')
        })}>Remove credential</button>
      </div></>}
    </>}
    {route.provider === 'builtin' && stage === 'capture' && <>
      <h3>Built-in local capture</h3>
      <p className="fine-print">MediaPipe Pose Landmarker runs on the CPU inside the visible Mocap window; no GPU, ComfyUI or Python is required. Choose Pose Lite (~5.5 MB) or Pose Full (~9 MB) under Capture options in Mocap. Models are downloaded once from Google and verified by SHA-256.</p>
    </>}
    {route.provider !== 'builtin' && stage === 'capture' && <p className="fine-print">Routed capture uploads the entire reference video, then requires a mapped <code>json</code> output with 33 MediaPipe-compatible world landmarks per frame for the requested clip. Retargeting and FBX export stay in local Blender.</p>}
    {route.provider === 'builtin' && native && stage !== 'capture' && <>
      <button className="text-button" aria-label="Refresh local models" disabled={disabled || checkingModels} onClick={() => void refreshModels()}>
        <RefreshCw size={14} className={checkingModels ? 'spin' : ''} /> Refresh installed models
      </button>
      {catalogError && <p className="modal-error" role="status">Could not refresh local model readiness: {catalogError}</p>}
      {stage !== 'motion' && stage !== 'global' && <NativeModelFields stage={stage} config={native} ready={ready} disabled={disabled} budgetText={budgetText} onChange={setNative} />}
      {stage === 'motion' && <>
        <label className="field-label" htmlFor="ai-native-encoder">Kimodo text encoder</label>
        <select id="ai-native-encoder" disabled={disabled} value={encoder} onChange={event => setEncoder(event.target.value === 'lfm' ? 'lfm' : 'llm2vec')}>
          <option value="llm2vec">Kimodo + Llama / LLM2Vec / high memory (~24 GiB recommended){encoderAdvice.encoder === 'llm2vec' ? ' / Recommended for available memory' : ''}</option>
          <option value="lfm">Kimodo + LFM bridge / low VRAM (experimental){encoderAdvice.encoder === 'lfm' ? ' / Recommended for available memory' : ''}</option>
        </select>
        {encoderGpu && <p className="fine-print" aria-label="Detected GPU memory">{encoderGpu.name}: {encoderGpu.freeGB.toFixed(1)} GiB free / {encoderGpu.totalGB.toFixed(1)} GiB total VRAM</p>}
        <p className="fine-print" id="encoder-memory-guidance">{encoderAdvice.detail} Memory budgets are estimates, not guarantees. Your saved encoder is never changed automatically.</p>
        <ModelSetupGuide comfyRoot={snapshot.settings.comfyRoot} textEncoder={encoder} checking={checkingModels}
          needsSetup={modelChecks.some(check => check.status === 'blocked' && check.name.includes('text encoder'))}
          onAccessPage={() => void perform(() => window.studio.openAccessPage())}
          onTokenSettings={() => void perform(() => window.studio.openTokenSettings())}
          onRefresh={() => void refreshModels()} />
        {modelChecks.filter(check => check.status !== 'ready').map(check => <p className="fine-print" key={check.name}>{check.name}: {check.detail}</p>)}
      </>}
      <p className="fine-print">Select installed weights; missing-model failures in the workflow offer supported downloads with approval. Optional adapters, Ollama and unsupported checkpoints need manual setup. Native rigging uses local Blender; built-in PBR generation is the TRELLIS.2 mesh preset, not a post-texturing pass.</p>
    </>}
    {error && <p className="modal-error" role="alert">{error}</p>}
    {notice && <p className="banner success" role="status">{notice}</p>}
    </div>
    <div className="model-settings-footer" inert={confirmClose}>
      <div className="settings-actions"><span className="fine-print">{dirty ? 'Unsaved changes' : 'Applies to future runs'}</span>
        <button className="primary" disabled={disabled || !dirty} onClick={() => void perform(save)}><Check size={16} /> Save settings</button></div>
      <p className="fine-print">Saving does not start generation. Remote execution still requires approval before prompts or assets leave this PC.</p>
    </div>
  </section></div>
}

export function AiRouteBadge({ snapshot, stage, onClick }: { snapshot: Snapshot; stage: AiStage; onClick?: () => void }) {
  const route = resolveAiRoute(snapshot.ai, stage)
  const native = snapshot.designer?.config
  const model = route.provider !== 'builtin' ? '' : stage === 'motion' ? snapshot.settings.textEncoder === 'lfm' ? 'Kimodo / LFM bridge' : 'Kimodo / Llama + LLM2Vec' :
    !native ? '' : stage === 'scene' ? native.checkpoint || imageProfiles[native.imageProfile].label :
    stage === 'tpose' ? tposeEditProfile.label : stage === 'cutout' ? 'BiRefNet' :
    stage === 'mesh' ? meshProfiles[native.meshProfile].label : stage === 'naming' ? native.titleModel : ''
  const label = `${aiRouteLabel(snapshot.ai, stage)}${model ? ` / ${model}` : ''}`
  return onClick ? <button className={`ai-route-badge ${route.location}`} aria-label={`${aiStages[stage]} provider: ${label}`} onClick={onClick}>{label}</button> :
    <span className={`ai-route-badge ${route.location}`}>{label}</span>
}
