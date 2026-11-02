import { useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Box, Check, CircleAlert, ImagePlus, LoaderCircle, Palette, Plus, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import type { Character, Snapshot } from '../shared/types'
import type { DesignRequest, DesignerConfig, DesignStage, MeshShapeDetail, MeshTextureSize } from '../shared/designer'
import { meshQualityOptions, texturedMeshSettings, tposeEditPrompt } from '../shared/designer'
import { designerModelPackages, type DesignerModelPackage } from '../shared/designer-models'
import { mergeSettingsDraft, type ProcessStep } from '../shared/workspace'
import { Viewport } from './Viewport'
import { WorkspaceLayout, ProcessStepper } from './WorkspaceLayout'
import './designer.css'
import { AiRouteBadge } from './AiProvidersPanel'
import { resolveAiRoute, type AiStage } from '../shared/ai'

const initial: DesignRequest = { title: '', description: '', style: '', seed: 42, steps: 30, referenceStrength: 0.3 }
const explain = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')
type QualitySettings = Pick<DesignerConfig, 'meshShapeDetail' | 'meshTextureSize' | 'meshFaceCount'>

export function DesignerPanel({ snapshot, visible, animatorBusy, onAnimate, onSettings, onProviders, onStep }: {
  snapshot: Snapshot; visible: boolean; animatorBusy: boolean; onAnimate: (character: Character) => void
  onSettings: () => void; onProviders: (stage: AiStage, field?: string) => void; onStep: (stage: AiStage) => void
}) {
  const data = snapshot.designer
  const [request, setRequest] = useState<DesignRequest>(initial)
  const [input, setInput] = useState<'text' | 'image'>('text')
  const [id, setId] = useState('')
  const [qualityDraft, setQualityDraft] = useState<QualitySettings>({})
  const qualityBase = useRef(data?.config)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<DesignStage>('scene')
  const [isolated, setIsolated] = useState(false)
  const design = data?.designs.find(d => d.id === id)
  const active = data?.designs.find(d => d.status === 'running')
  const download = data?.modelDownload
  const downloading = download?.status === 'running'
  const locked = busy || !!active || animatorBusy || downloading
  const recovery = design?.status === 'failed' ? design.recovery : undefined
  const recovered = download?.status === 'complete' && download.package === recovery?.package
  const displayError = error || (!recovered && design?.status === 'failed' ? design.message : '')
  const settingsDirty = Object.entries(qualityDraft).some(([key, value]) => data?.config[key as keyof QualitySettings] !== value)
  const quality = texturedMeshSettings({ ...data?.config, ...qualityDraft })
  const reference = data?.references.find(r => r.id === request.referenceId)
  const url = design?.[`${preview}Url`]
  const source = design?.sources?.[preview]
  const sceneBlocked = request.description.trim().length < 3 || request.style.trim().length < 3 || input === 'image' && !reference
  const textureConfigured = resolveAiRoute(snapshot.ai, 'texture').provider !== 'builtin'
  const visibleRoutes: AiStage[] = preview === 'scene' ? ['scene'] :
    preview === 'tpose' ? design?.tposeUrl && !design.tposeIsolated ? ['cutout'] : ['tpose', 'cutout'] :
      textureConfigured ? ['mesh', 'texture'] : ['mesh']
  const stages: { key: DesignStage; label: string; detail: string }[] = [
    { key: 'scene', label: 'Character & scene', detail: 'Identity, story and art direction' },
    { key: 'tpose', label: 'T-pose reference', detail: 'Transparent character cutout' },
    { key: 'model', label: '3D model', detail: 'Geometry or textured GLB' }
  ]
  const processSteps: ProcessStep[] = stages.map(stage => ({
    id: stage.key, label: stage.label, detail: stage.detail,
    complete: !!design?.[`${stage.key}Url`] && (stage.key !== 'tpose' || design.tposeIsolated),
    state: design?.stage === stage.key && design.status !== 'idle' ? design.status :
      design?.sources?.[stage.key]?.kind === 'imported' ? 'imported' : undefined
  }))

  function selectStep(stage: string) {
    if (stage !== 'scene' && stage !== 'tpose' && stage !== 'model') return
    setPreview(stage); onStep(stage === 'model' ? 'mesh' : stage)
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (error) { setError(explain(error)) } finally { setBusy(false) }
  }
  async function run(stage: DesignStage) {
    if (!design) return
    await perform(async () => {
      const brief = { ...request, referenceId: input === 'image' ? request.referenceId : undefined }
      const changed = (Object.keys(brief) as (keyof DesignRequest)[]).some(key => brief[key] !== design.request[key])
      const cleanupOnly = stage === 'tpose' && design.tposeUrl && !design.tposeIsolated
      const variation = changed || !!design[`${stage}Url`] && !cleanupOnly ||
        stage === 'scene' && !!(design.tposeUrl || design.modelUrl)
      const target = variation ? await window.studio.designerVariation(design.id, stage, brief) : design.id
      setId(target); selectStep(stage)
      await window.studio.designerRun(target, stage)
    })
  }
  async function installModels(packageId: DesignerModelPackage) {
    await perform(async () => {
      const installed = await window.studio.designerInstallModels(packageId)
      if (installed) setNotice('Required models verified and selected. Retry the stage when ready.')
    })
  }
  function reviewModels() {
    const stage = recovery?.package === 'background' ? 'cutout' : recovery?.package === 'edit' ? 'tpose' : preview === 'model' ? 'mesh' : preview
    onProviders(stage, stage === 'cutout' ? 'design-backgroundModel' : stage === 'tpose' ? 'design-editModel' : stage === 'mesh' ? 'mesh-profile' : 'image-profile')
  }
  function changeQuality(next: QualitySettings) {
    if (!settingsDirty) qualityBase.current = data?.config
    setQualityDraft(old => ({ ...old, ...next }))
  }
  const importControls = preview !== 'scene' && <section className="design-entry">
    <p className="design-entry-label">Skip ahead with an existing {preview === 'model' ? 'GLB mesh' : 'T-pose'}</p>
    <button className="secondary full" disabled={locked} onClick={() => void perform(async () => {
      const imported = await window.studio.designerImport({ stage: preview, brief: request, isolated: preview === 'tpose' && isolated })
      if (imported) setId(imported)
    })}><ImagePlus size={15} /> Import {preview === 'model' ? 'GLB mesh' : 'T-pose'}</button>
    {preview === 'tpose' && <label className="design-cutout-choice"><input type="checkbox" checked={isolated} disabled={locked} onChange={e => setIsolated(e.target.checked)} /> Already isolated transparent PNG - skip background removal</label>}
    <p className="fine-print">Creates a new design and preserves the original file. {preview === 'tpose' ? 'Use a full-body T-pose with clear margins.' : 'GLB must embed its resources. Import FBX in Animator.'}</p>
  </section>

  return <WorkspaceLayout id="designer-panel" labelledBy="designer-tab" hidden={!visible} step={preview}>
    <aside className="workflow-settings" aria-label="Designer step settings">
      <div className="section-kicker">{preview === 'scene' ? '01 / IMAGINE A CHARACTER' : preview === 'tpose' ? '02 / PREPARE THE REFERENCE' : '03 / BUILD THE MODEL'}</div>
      <h1>{stages.find(stage => stage.key === preview)?.label}</h1>
      <p className="panel-description">{preview === 'scene' ? 'Start with a story or reference. Shape the look before moving on.' : preview === 'tpose' ? 'Use the completed scene or import a T-pose. Review the cutout before 3D.' : 'Generate from a validated T-pose, or inspect an imported model.'}</p>
      {preview === 'scene' && <>
        <div className="view-tabs design-input-tabs" role="group" aria-label="Design input">
          <button aria-pressed={input === 'text'} disabled={locked} className={input === 'text' ? 'active' : ''} onClick={() => setInput('text')}>Text description</button>
          <button aria-pressed={input === 'image'} disabled={locked} className={input === 'image' ? 'active' : ''} onClick={() => setInput('image')}>Reference image</button>
        </div>
        {input === 'image' && <div className="design-reference">
          {reference && <img src={reference.url} alt={`Input reference: ${reference.name}`} />}
          <button className="secondary full" disabled={locked} onClick={() => void perform(async () => {
            const image = await window.studio.designerReference()
            if (image) setRequest(old => ({ ...old, referenceId: image.id }))
          })}><ImagePlus size={16} /> {reference ? 'Replace local image' : 'Choose local image'}</button>
          <p className="fine-print">PNG, JPEG or WebP, up to 20 MB. Copied locally; remote transmission requires approval. References guide a newly generated scene, not a replacement for scene generation.</p>
        </div>}
        <label className="field-label" htmlFor="design-title">Character title <span>optional</span></label>
        {!request.title && <AiRouteBadge snapshot={snapshot} stage="naming" onClick={() => onProviders('naming')} />}
        <input id="design-title" disabled={locked} maxLength={100} placeholder="Leave blank for AI naming" value={request.title} onChange={e => setRequest({ ...request, title: e.target.value })} />
        <label className="field-label" htmlFor="design-description">{input === 'image' ? 'What to use from this photo' : 'Character & scenario'}</label>
        <textarea id="design-description" disabled={locked} maxLength={2000} rows={4} placeholder="Describe your character and their world..." value={request.description} onChange={e => setRequest({ ...request, description: e.target.value })} />
        <label className="field-label" htmlFor="design-style">Art style</label>
        <textarea id="design-style" disabled={locked} maxLength={1000} rows={3} placeholder="Color, shapes, materials and art direction..." value={request.style} onChange={e => setRequest({ ...request, style: e.target.value })} />
      </>}
      {importControls}
      {preview === 'tpose' && <details className="model-advanced"><summary>T-pose edit instruction</summary><p className="fine-print">{tposeEditPrompt}</p><p className="fine-print">The scene image is the edit source. Character/scenario and art-style descriptions are not sent again.</p></details>}
      <details className="model-advanced"><summary>Advanced generation</summary>
        <label className="field-label" htmlFor="design-seed">Seed</label>
        <input id="design-seed" aria-label="Design seed" disabled={locked} type="number" min={0} max={4294967295} value={request.seed} onChange={e => setRequest({ ...request, seed: Number(e.target.value) })} />
        {preview !== 'tpose' && <><label className="field-label" htmlFor="design-steps">Scene / Hunyuan steps</label><input id="design-steps" aria-label="Design steps" disabled={locked} type="number" min={10} max={100} value={request.steps} onChange={e => setRequest({ ...request, steps: Number(e.target.value) })} /></>}
        {preview === 'scene' && <>
          <label className="field-label" htmlFor="design-strength">Reference influence <span>{Math.round(request.referenceStrength * 100)}%</span></label>
          <input id="design-strength" type="range" min={0.1} max={0.6} step={0.05} disabled={locked} value={request.referenceStrength} onChange={e => setRequest({ ...request, referenceStrength: Number(e.target.value) })} />
        </>}
        <p className="fine-print">Saved with each run. Built-in FLUX.2 uses four steps; custom providers use their mapped workflow.</p>
      </details>
      {preview === 'model' && data?.config.meshProfile === 'textured' && resolveAiRoute(snapshot.ai, 'mesh').provider === 'builtin' && <section aria-label="3D output quality">
        <label className="field-label" htmlFor="design-mesh-detail">3D shape detail</label>
        <select id="design-mesh-detail" disabled={locked} value={quality.shapeDetail} onChange={e => changeQuality({ meshShapeDetail: Number(e.target.value) as MeshShapeDetail })}>{meshQualityOptions.shapeDetail.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <label className="field-label" htmlFor="design-texture-size">3D texture size</label>
        <select id="design-texture-size" disabled={locked} value={quality.textureSize} onChange={e => changeQuality({ meshTextureSize: Number(e.target.value) as MeshTextureSize })}>{meshQualityOptions.textureSize.map(size => <option key={size} value={size}>{size / 1024}K atlas</option>)}</select>
        <label className="field-label" htmlFor="design-face-count">3D target face count</label>
        <select id="design-face-count" disabled={locked} value={quality.faceCount} onChange={e => changeQuality({ meshFaceCount: Number(e.target.value) })}>{[...new Set([...meshQualityOptions.faceCount, quality.faceCount])].sort((a, b) => a - b).map(count => <option key={count} value={count}>{count.toLocaleString()} faces</option>)}</select>
        <p className="fine-print">Higher detail and larger textures increase memory, generation time and later rigging cost. Settings apply to new runs, not existing meshes.</p>
      </section>}
      {settingsDirty && <div className="banner" role="status"><div><p>Unsaved output quality. Save or discard before generation.</p>
        <button className="secondary" disabled={locked} onClick={() => void perform(async () => {
          const latest = await window.studio.snapshot()
          if (!qualityBase.current || !latest.designer) throw new Error('Designer settings are unavailable. Reopen this workspace.')
          await window.studio.designerSettings(mergeSettingsDraft(qualityBase.current, { ...qualityBase.current, ...qualityDraft }, latest.designer.config))
          setQualityDraft({}); setNotice('Output quality saved.')
        })}>Save output quality</button>
        <button className="text-button" disabled={locked} onClick={() => setQualityDraft({})}>Discard output quality</button>
      </div></div>}
      <div className="ai-stage-routes" role="group" aria-label="Current step models">{visibleRoutes.map(stage =>
        <AiRouteBadge key={stage} snapshot={snapshot} stage={stage} onClick={() => onProviders(stage)} />)}</div>
      {!design && preview === 'scene' && <button className="primary full" disabled={locked || settingsDirty || sceneBlocked} onClick={() => void perform(async () => {
        const created = await window.studio.designerCreate({ ...request, referenceId: input === 'image' ? request.referenceId : undefined })
        setId(created); selectStep('scene'); await window.studio.designerRun(created, 'scene')
      })}><Sparkles size={16} /> Create character concept <ArrowRight size={16} /></button>}
      {design && <div className="design-actions">
        {preview === 'scene' && <button className="primary full" disabled={locked || settingsDirty || sceneBlocked} onClick={() => void run('scene')}><RefreshCw size={15} /> {design.sceneUrl ? 'Regenerate scene' : 'Generate scene'}</button>}
        {preview === 'tpose' && design.sceneUrl && (!design.tposeUrl || design.tposeIsolated) && <button className="primary full" disabled={locked || settingsDirty} onClick={() => void run('tpose')}><Sparkles size={15} /> {design.tposeUrl ? 'Regenerate T-pose' : 'Use scene & generate T-pose'}</button>}
        {preview === 'tpose' && design.tposeUrl && !design.tposeIsolated && <button className="primary full" disabled={locked || settingsDirty} onClick={() => void run('tpose')}><RefreshCw size={15} /> Remove T-pose background</button>}
        {preview === 'model' && design.tposeIsolated && <button className="primary full" disabled={locked || settingsDirty} onClick={() => void run('model')}><Box size={15} /> {design.modelUrl ? 'Regenerate 3D' : 'Use T-pose & generate 3D'}</button>}
        {preview === 'tpose' && !design.sceneUrl && !design.tposeUrl && <p className="fine-print">Generate a scene first or import a T-pose above.</p>}
        {preview === 'model' && !design.tposeIsolated && <p className="fine-print">Generate/import an isolated T-pose before 3D generation, or import a GLB above.</p>}
        {design.modelUrl && preview === 'model' && (['texture', 'rig'] as const).map(stage => <div key={stage}>
          <AiRouteBadge snapshot={snapshot} stage={stage} onClick={() => onProviders(stage)} />
          <button className="secondary full" disabled={locked || resolveAiRoute(snapshot.ai, stage).provider === 'builtin'} onClick={() => void perform(async () => {
            const next = await window.studio.designerProcessModel(design.id, stage); setId(next); selectStep('model')
          })}>{stage === 'rig' ? 'Create rigged GLB variation' : 'Create PBR texture variation'}</button>
        </div>)}
      </div>}
      <details className="workspace-collection"><summary>Saved designs ({data?.designs.length ?? 0})</summary>
        <div className="design-list">{data?.designs.map(item => <button key={item.id} className={`asset ${item.id === id ? 'active' : ''}`} disabled={locked} onClick={() => {
          setId(item.id); setRequest({ ...item.request, title: item.title }); setInput(item.request.referenceId ? 'image' : 'text')
          selectStep(item.modelUrl ? 'model' : item.tposeUrl ? 'tpose' : 'scene'); setError('')
        }}><Palette size={16} /><span><strong>{item.title || 'Untitled concept'}</strong><small>{item.status === 'failed' || item.status === 'cancelled' ? item.status : item.modelUrl ? '3D model ready' : item.tposeUrl ? item.tposeIsolated ? 'T-pose ready' : 'T-pose needs cleanup' : item.sceneUrl ? 'Scene ready' : 'Not generated'}</small></span></button>)}</div>
        <button className="secondary full" disabled={locked} onClick={() => { setId(''); selectStep('scene') }}><Plus size={15} /> New concept</button>
      </details>
    </aside>
    <main className="workflow-main" aria-label="Designer canvas">
      <ProcessStepper label="Designer process" steps={processSteps} current={preview} onSelect={selectStep} />
      <div className="scene-heading"><div><span className="section-kicker">DESIGN CANVAS</span><h2>{design?.title || 'A character waiting to happen'}</h2></div></div>
      {url && <p className="design-source">{source?.kind === 'imported' ? `Imported: ${source.name}` : source?.input ? `Generated from this design's ${source.input === 'tpose' ? 'validated T-pose' : 'scene reference'}.` : `Saved ${preview === 'scene' ? 'scene reference' : preview === 'tpose' ? 'T-pose reference' : '3D model'}.`}</p>}
      <div className={`design-canvas ${preview === 'model' ? 'mesh' : preview === 'tpose' && design?.tposeIsolated ? 'cutout' : ''}`}>
        {url && preview === 'model' && visible ? <Viewport url={url} fit={false} selected="" kind="input" onSelect={() => {}} onMove={() => {}} /> :
          url && preview !== 'model' ? <img src={url} alt={preview === 'scene' ? 'Character and scene reference for review' : 'T-pose reference for review'} /> :
          <div className="design-empty"><div className="design-empty-icon">{preview === 'model' ? <Box size={42} strokeWidth={1} /> : <Palette size={42} strokeWidth={1} />}</div>
            <h2>{preview === 'scene' ? 'Start with a little imagination.' : preview === 'tpose' ? 'Same character. A clean silhouette.' : 'From reference to dimension.'}</h2>
            <p>{preview === 'scene' ? 'Your character, their world, your art direction.' : preview === 'tpose' ? 'Review the scene, then generate a front-facing T-pose.' : 'Review the isolated T-pose before building geometry.'}</p>
          </div>}
      </div>
      {active && <div className="job-progress" role="status"><LoaderCircle size={18} className="spin" /><div><strong>{active.stage?.toUpperCase()}</strong><p>{active.message}</p></div><button onClick={() => void window.studio.designerCancel().catch(error => setError(explain(error)))}>Cancel design</button></div>}
      {animatorBusy && <p className="fine-print">Animator is using the shared job slot. Designer generation will be available when it finishes.</p>}
      {displayError && <div className="banner error design-recovery" role="alert"><CircleAlert size={17} /><div><p>{displayError}</p>
        <div className="design-recovery-actions">
          {recovery?.package && !recovered && <button className="secondary" disabled={locked || settingsDirty} onClick={() => void installModels(recovery.package!)}><ArrowDownToLine size={15} /> Download required models</button>}
          <button className="secondary" disabled={locked} onClick={reviewModels}>Review model settings</button>
          <button className="text-button" disabled={locked} onClick={onSettings}>Backend connections</button>
        </div>
        {recovery?.package && !recovered && <p className="fine-print">{designerModelPackages[recovery.package].label}. Review download size and terms before approving. {settingsDirty && 'Save output quality first.'}</p>}
      </div></div>}
      {download && <div className={`banner ${download.status === 'failed' ? 'error' : download.status === 'complete' ? 'success' : ''} design-download`} role="status"><div><p>{download.message}</p>
        {downloading && download.totalBytes > 0 && <><progress aria-label="Model download progress" value={download.receivedBytes} max={download.totalBytes} /><span>{(download.receivedBytes / 2 ** 30).toFixed(2)} / {(download.totalBytes / 2 ** 30).toFixed(2)} GiB</span></>}
        {downloading && <button className="secondary" onClick={() => void window.studio.designerCancelDownload().catch(error => setError(explain(error)))}>Cancel download</button>}
      </div></div>}
      {notice && <div className="banner success" role="status"><Check size={17} /><span>{notice}</span></div>}
      {design && design.status !== 'running' && design.status !== 'failed' && <p className="design-status">{design.message}</p>}
      <div className="design-actions">
        {url && <button className="secondary" disabled={locked} onClick={() => void perform(async () => { const path = await window.studio.designerExport(design!.id, preview); if (path) setNotice(`Saved ${path}`) })}><ArrowDownToLine size={15} /> Save {preview === 'model' ? design?.modelRigged ? 'rigged GLB' : design?.modelTextured ? 'textured GLB' : 'GLB geometry' : 'reference PNG'}</button>}
        {preview !== 'model' && <button className="secondary" onClick={() => selectStep(preview === 'scene' ? 'tpose' : 'model')}>Next: {preview === 'scene' ? 'T-pose reference' : '3D model'} <ArrowRight size={15} /></button>}
        {preview === 'model' && design?.modelUrl && <button className="primary" disabled={locked} onClick={() => void perform(async () => onAnimate(await window.studio.designerAnimate(design.id)))}><ArrowRight size={15} /> {design.characterId ? 'Open in Animator' : 'Send to Animator'}</button>}
        {design && <button className="text-button" disabled={locked} onClick={() => { setRequest({ ...design.request, title: design.title }); setInput(design.request.referenceId ? 'image' : 'text'); setId(''); selectStep('scene'); setNotice('Brief copied. Change it, then create a new concept.'); setError('') }}><Plus size={14} /> Use brief for variation</button>}
      </div>
      {design && <p className="fine-print">Reruns create saved variations. Earlier outputs and Animator characters stay unchanged; identical settings and seeds may reproduce the same result.</p>}
      {!!design?.ai?.length && <details className="fine-print"><summary>Saved provider provenance</summary>{design.ai.map((record, index) => <p key={index}>{record.stage}: {record.route.location} / {record.route.provider} / {record.route.model || 'native preset'}<br />{record.route.endpoint}<br />Configuration: {record.configurationHash}<br />{record.taskId && `Task: ${record.taskId}`}</p>)}</details>}
      <div className="design-limits"><ShieldCheck size={17} /><p>Review each stage. 3D uses the validated T-pose, not the scene. Built-in Hunyuan3D produces geometry; TRELLIS.2 produces a textured model. Both are <strong>unrigged</strong>. Remote rigs are not guaranteed compatible with Animator's SOMA body rig. Review surfaces, seams, anatomy and hands.</p></div>
    </main>
  </WorkspaceLayout>
}
