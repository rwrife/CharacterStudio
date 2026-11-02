import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Box, Check, CircleAlert, ImagePlus, LoaderCircle, Palette, PanelRightClose, PanelRightOpen, Plus, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import type { Character, Snapshot } from '../shared/types'
import type { DesignRequest, DesignerConfig, DesignerReadiness, DesignStage, MeshShapeDetail, MeshTextureSize } from '../shared/designer'
import { imageProfiles, meshProfiles, meshQualityOptions, meshTextureProfile, texturedMeshSettings, tposeEditProfile, tposeEditPrompt } from '../shared/designer'
import { designerModelPackages, type DesignerModelPackage } from '../shared/designer-models'
import { Viewport } from './Viewport'
import './designer.css'

const initial: DesignRequest = { title: '', description: '', style: '', seed: 42, steps: 30, referenceStrength: 0.3 }
const explain = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')

export function DesignerPanel({ snapshot, visible, animatorBusy, onAnimate, onSettings }: {
  snapshot: Snapshot; visible: boolean; animatorBusy: boolean; onAnimate: (character: Character) => void; onSettings: () => void
}) {
  const data = snapshot.designer
  const [request, setRequest] = useState<DesignRequest>(initial)
  const [input, setInput] = useState<'text' | 'image'>('text')
  const [id, setId] = useState('')
  const [config, setConfig] = useState<DesignerConfig | undefined>(data?.config)
  const [ready, setReady] = useState<DesignerReadiness>()
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<DesignStage>('scene')
  const [isolated, setIsolated] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(true)
  const [reviewTarget, setReviewTarget] = useState('')
  const design = data?.designs.find(d => d.id === id)
  const active = data?.designs.find(d => d.status === 'running')
  const download = data?.modelDownload
  const downloading = download?.status === 'running'
  const locked = busy || !!active || animatorBusy || downloading
  const recovery = design?.status === 'failed' ? design.recovery : undefined
  const recovered = download?.status === 'complete' && download.package === recovery?.package
  const displayError = error || (!recovered && design?.status === 'failed' ? design.message : '')
  const settingsDirty = (['imageProfile', 'checkpoint', 'controlnet', 'meshProfile', 'meshCheckpoint', 'titleModel', 'ipadapter', 'clipVision', 'backgroundModel', 'editModel', 'editTextEncoder', 'editVae', 'meshTextureModel', 'meshVision', 'meshShapeVae', 'meshTextureVae', 'meshShapeDetail', 'meshTextureSize', 'meshFaceCount'] as const)
    .some(key => (config?.[key] ?? '') !== (data?.config[key] ?? ''))
  const quality = texturedMeshSettings(config ?? {})
  const reference = data?.references.find(r => r.id === request.referenceId)
  const free = Math.max(0, ...(ready?.devices.map(d => d.freeGB) ?? []))
  const url = design?.[`${preview}Url`]
  const source = design?.sources?.[preview]
  const sceneBlocked = request.description.trim().length < 3 || request.style.trim().length < 3 || input === 'image' && !reference

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (error) { setError(explain(error)) } finally { setBusy(false) }
  }
  async function refresh() {
    setChecking(true); setError('')
    try { setReady(await window.studio.designerReadiness()) } catch (error) { setError(explain(error)); setReady(undefined) } finally { setChecking(false) }
  }
  useEffect(() => { if (visible) void refresh() }, [visible, snapshot.settings.comfyUrl])
  useEffect(() => { if (!config && data?.config) setConfig(data.config) }, [data?.config])
  useEffect(() => {
    if (!modelsOpen || !reviewTarget) return
    const field = document.getElementById(reviewTarget)
    field?.scrollIntoView({ block: 'center' })
    field?.focus()
    setReviewTarget('')
  }, [modelsOpen, reviewTarget])

  const stages: { key: DesignStage; label: string; detail: string }[] = [
    { key: 'scene', label: 'Character & scene', detail: 'Identity, story and art direction' },
    { key: 'tpose', label: 'T-pose reference', detail: 'Transparent character cutout' },
    { key: 'model', label: '3D model', detail: 'Geometry or textured GLB' }
  ]
  async function run(stage: DesignStage) {
    if (!design) return
    await perform(async () => {
      const brief = { ...request, referenceId: input === 'image' ? request.referenceId : undefined }
      const changed = (Object.keys(brief) as (keyof DesignRequest)[]).some(key => brief[key] !== design.request[key])
      const cleanupOnly = stage === 'tpose' && design.tposeUrl && !design.tposeIsolated
      const variation = changed || !!design[`${stage}Url`] && !cleanupOnly ||
        stage === 'scene' && !!(design.tposeUrl || design.modelUrl)
      const target = variation ? await window.studio.designerVariation(design.id, stage, brief) : design.id
      setId(target); setPreview(stage)
      await window.studio.designerRun(target, stage)
    })
  }
  async function installModels(packageId: DesignerModelPackage) {
    await perform(async () => {
      const installed = await window.studio.designerInstallModels(packageId)
      if (installed) {
        setConfig(installed)
        setReady(await window.studio.designerReadiness())
        setNotice('Required models verified and selected. Retry the stage when ready.')
      }
    })
  }
  function reviewModels() {
    setModelsOpen(true)
    setReviewTarget(recovery?.package === 'background' ? 'design-background' :
      recovery?.package === 'edit' ? 'design-editModel' : 'image-profile')
  }

  return <div id="designer-panel" role="tabpanel" aria-labelledby="designer-tab" hidden={!visible} className={`designer-layout${modelsOpen ? '' : ' models-hidden'}`}>
    <aside className="design-brief" aria-label="Designer brief">
      <div className="section-kicker">01 / IMAGINE A CHARACTER</div>
      <h1>Character designer</h1>
      <p className="panel-description">Start with a story or a reference. Shape the look, review the pose, then build a mesh.</p>
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
        <p className="fine-print">PNG, JPEG or WebP, up to 20 MB. Copied locally; sent only to your loopback ComfyUI. The photo guides a newly generated scene; it is not used as the scene itself.</p>
      </div>}
      <label className="field-label" htmlFor="design-title">Character title <span>optional</span></label>
      <input id="design-title" disabled={locked} maxLength={100} placeholder="Leave blank for local AI naming" value={request.title} onChange={e => setRequest({ ...request, title: e.target.value })} />
      <label className="field-label" htmlFor="design-description">{input === 'image' ? 'What to use from this photo' : 'Character & scenario'}</label>
      <textarea id="design-description" disabled={locked} maxLength={2000} rows={5} placeholder={input === 'image' ? 'Use the person in this photo as a heavyweight boxer in a neon-lit arena...' : 'A Brazilian MMA fighter raised in the jungles of Brazil...'} value={request.description} onChange={e => setRequest({ ...request, description: e.target.value })} />
      <label className="field-label" htmlFor="design-style">Art style</label>
      <textarea id="design-style" disabled={locked} maxLength={1000} rows={4} placeholder="A 90s video game character, bright vibrant colors, exaggerated muscles and upper body features..." value={request.style} onChange={e => setRequest({ ...request, style: e.target.value })} />
      <div className="two-fields design-sampling">
        <label>Seed<input aria-label="Design seed" disabled={locked} type="number" min={0} max={4294967295} value={request.seed} onChange={e => setRequest({ ...request, seed: Number(e.target.value) })} /></label>
        <label>Scene / Hunyuan steps<input aria-label="Design steps" disabled={locked} type="number" min={10} max={100} value={request.steps} onChange={e => setRequest({ ...request, steps: Number(e.target.value) })} /></label>
      </div>
      <label className="field-label" htmlFor="design-strength">Reference influence <span>{Math.round(request.referenceStrength * 100)}%</span></label>
      <input id="design-strength" type="range" min={0.1} max={0.6} step={0.05} disabled={locked} value={request.referenceStrength} onChange={e => setRequest({ ...request, referenceStrength: Number(e.target.value) })} />
      <p className="fine-print">For creating a scene from an optional reference image. T-pose editing instead uses the completed scene directly, with its own fixed four-step edit workflow.</p>
      <button className="primary full" disabled={locked || settingsDirty || sceneBlocked} onClick={() => void perform(async () => {
        const created = await window.studio.designerCreate({ ...request, referenceId: input === 'image' ? request.referenceId : undefined })
        setId(created); setPreview('scene')
        await window.studio.designerRun(created, 'scene')
      })}><Sparkles size={16} /> Create character concept <ArrowRight size={16} /></button>
      <p className="fine-print">Each concept keeps its own brief, seed, model settings and workflow files. Existing completed stages are never overwritten.</p>
      <div className="panel-rule" />
      <div className="section-heading"><span className="section-kicker">SAVED DESIGNS</span><span className="count">{data?.designs.length ?? 0}</span></div>
      <div className="design-list">
        {data?.designs.map(item => <button key={item.id} className={`asset ${item.id === id ? 'active' : ''}`} disabled={locked} onClick={() => { setId(item.id); setRequest({ ...item.request, title: item.title }); setInput(item.request.referenceId ? 'image' : 'text'); setPreview(item.modelUrl ? 'model' : item.tposeUrl ? 'tpose' : 'scene'); setError('') }}>
          <Palette size={16} /><span><strong>{item.title || 'Untitled concept'}</strong><small>{item.status === 'failed' || item.status === 'cancelled' ? item.status : item.modelUrl ? item.modelTextured ? 'Textured model ready' : '3D geometry ready' : item.tposeUrl ? item.tposeIsolated ? 'T-pose ready' : 'T-pose needs cleanup' : item.sceneUrl ? 'Scene ready' : 'Not generated'}</small></span>
        </button>)}
        {!data?.designs.length && <p className="fine-print">Your character concepts will appear here.</p>}
      </div>
    </aside>
    <main className="design-workspace" aria-label="Designer canvas">
      <div className="scene-heading"><div><span className="section-kicker">DESIGN CANVAS</span><h2>{design?.title || 'A character waiting to happen'}</h2></div>
        <button className="secondary design-model-toggle" aria-expanded={modelsOpen} aria-controls="designer-model-profiles" onClick={() => setModelsOpen(!modelsOpen)}>
          {modelsOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          {modelsOpen ? 'Hide model settings' : 'Show model settings'}
          {settingsDirty && <span className="design-model-unsaved">Unsaved</span>}
        </button>
      </div>
      <div className="design-stages">
        {stages.map((stage, index) => {
          const complete = !!design?.[`${stage.key}Url`] && (stage.key !== 'tpose' || design.tposeIsolated)
          return <button key={stage.key} className={`${preview === stage.key ? 'selected' : ''} ${complete ? 'ready' : ''}`} onClick={() => setPreview(stage.key)} aria-pressed={preview === stage.key}>
            <span className="step-number">{complete ? <Check size={13} /> : index + 1}</span><span><strong>{stage.label}</strong><small>{stage.detail}</small></span>
          </button>
        })}
      </div>
      {preview !== 'scene' && <div className="design-entry">
        <span className="design-entry-label">Skip ahead with an existing {preview === 'model' ? 'GLB mesh' : 'T-pose'}</span>
        <div className="design-entry-controls">
          <button className="secondary" disabled={locked} onClick={() => void perform(async () => {
            const stage = preview
            const imported = await window.studio.designerImport({ stage, brief: request, isolated: stage === 'tpose' && isolated })
            if (imported) { setId(imported); setPreview(stage) }
          })}><ImagePlus size={15} /> Import {preview === 'model' ? 'GLB mesh' : 'T-pose'}</button>
        </div>
        {preview === 'tpose' && <label className="design-cutout-choice"><input type="checkbox" checked={isolated} disabled={locked} onChange={e => setIsolated(e.target.checked)} /> Already isolated transparent PNG - skip background removal</label>}
        <p className="fine-print">Creates a new design and preserves the original file. Descriptions are optional for imported inputs. {preview === 'tpose' ? 'Use a full-body T-pose with clear margins; otherwise remove its background before 3D.' : 'GLB must embed its resources. Import FBX directly in Animator.'}</p>
      </div>}
      {url && <p className="design-source">{source?.kind === 'imported' ? `Imported: ${source.name}` : source?.input ? `Generated from this design's ${source.input === 'tpose' ? 'validated T-pose' : 'scene reference'}.` : `Saved ${preview === 'scene' ? 'scene reference' : preview === 'tpose' ? 'T-pose reference' : '3D geometry'}.`}</p>}
      {preview === 'tpose' && <details className="design-edit-instruction"><summary>T-pose edit instruction</summary><p>{tposeEditPrompt}</p><p>The scene image is the edit source. Character/scenario and art-style descriptions are not sent again.</p></details>}
      <div className={`design-canvas ${preview === 'model' ? 'mesh' : preview === 'tpose' && design?.tposeIsolated ? 'cutout' : ''}`}>
        {url && preview === 'model' && visible ? <Viewport url={url} fit={false} selected="" kind="input" onSelect={() => {}} onMove={() => {}} /> :
          url && preview !== 'model' ? <img src={url} alt={preview === 'scene' ? 'Character and scene reference for review' : 'T-pose reference for review'} /> :
          <div className="design-empty"><div className="design-empty-icon">{preview === 'model' ? <Box size={42} strokeWidth={1} /> : <Palette size={42} strokeWidth={1} />}</div>
            <h2>{preview === 'scene' ? 'Start with a little imagination.' : preview === 'tpose' ? 'Same character. A clean silhouette.' : 'From reference to dimension.'}</h2>
            <p>{preview === 'scene' ? 'Your character, their world, your art direction.' : preview === 'tpose' ? 'Review the scene, then generate a front-facing T-pose.' : 'Approve the isolated T-pose before building geometry.'}</p>
            <span>LOCAL MODELS / YOUR MACHINE</span>
          </div>}
      </div>
      {active && <div className="job-progress" role="status"><LoaderCircle size={18} className="spin" /><div><strong>{active.stage?.toUpperCase()}</strong><p>{active.message}</p></div><button disabled={active.status !== 'running'} onClick={() => void window.studio.designerCancel().catch(error => setError(explain(error)))}>Cancel design</button></div>}
      {animatorBusy && <p className="fine-print">Animator is using the shared local job slot. Designer generation will be available when it finishes.</p>}
      {displayError && <div className="banner error design-recovery" role="alert"><CircleAlert size={17} /><div>
        <p>{displayError}</p>
        <div className="design-recovery-actions">
          {recovery?.package && !recovered && <button className="secondary" disabled={locked || settingsDirty} onClick={() => void installModels(recovery.package!)}>
            <ArrowDownToLine size={15} /> Download required models
          </button>}
          <button className="secondary" disabled={locked} onClick={reviewModels}>Review model settings</button>
          <button className="text-button" disabled={locked} onClick={onSettings}>Backend connections</button>
        </div>
        {recovery?.package && !recovered && <p className="fine-print">{designerModelPackages[recovery.package].label}. Review the download size and model terms before approving. {settingsDirty && 'Save model choices first.'}</p>}
      </div></div>}
      {download && <div className={`banner ${download.status === 'failed' ? 'error' : download.status === 'complete' ? 'success' : ''} design-download`} role="status">
        {downloading ? <LoaderCircle size={17} className="spin" /> : <ArrowDownToLine size={17} />}
        <div><p>{download.message}</p>
          {downloading && download.totalBytes > 0 && <>
            <progress aria-label="Model download progress" value={download.receivedBytes} max={download.totalBytes} />
            <span>{(download.receivedBytes / 2 ** 30).toFixed(2)} / {(download.totalBytes / 2 ** 30).toFixed(2)} GiB</span>
          </>}
          {downloading && <button className="secondary" onClick={() => void window.studio.designerCancelDownload().catch(error => setError(explain(error)))}>Cancel download</button>}
        </div>
      </div>}
      {notice && <div className="banner success" role="status"><Check size={17} /><span>{notice}</span></div>}
      {design && design.status !== 'running' && design.status !== 'failed' && <p className="design-status">{design.message}</p>}
      {design && <div className="design-actions">
        <button className="primary" disabled={locked || settingsDirty || sceneBlocked} onClick={() => void run('scene')}><RefreshCw size={15} /> {design.sceneUrl ? 'Regenerate scene' : 'Generate scene'}</button>
        {design.sceneUrl && (!design.tposeUrl || design.tposeIsolated) && <button className="primary" disabled={locked || settingsDirty} onClick={() => void run('tpose')}><Check size={15} /> {design.tposeUrl ? 'Regenerate T-pose' : 'Use scene & generate T-pose'} <ArrowRight size={15} /></button>}
        {design.tposeUrl && !design.tposeIsolated && <button className="primary" disabled={locked || settingsDirty} onClick={() => void run('tpose')}><RefreshCw size={15} /> Remove T-pose background</button>}
        {design.tposeIsolated && <button className="primary" disabled={locked || settingsDirty} onClick={() => void run('model')}><Box size={15} /> {design.modelUrl ? 'Regenerate 3D' : 'Use T-pose & generate 3D'} <ArrowRight size={15} /></button>}
        {design.modelUrl && <button className="primary" disabled={locked} onClick={() => void perform(async () => onAnimate(await window.studio.designerAnimate(design.id)))}><ArrowRight size={15} /> {design.characterId ? 'Open in Animator' : 'Send to Animator'}</button>}
        {url && <button className="secondary" disabled={locked} onClick={() => void perform(async () => { const path = await window.studio.designerExport(design.id, preview); if (path) setNotice(`Saved ${path}`) })}><ArrowDownToLine size={15} /> Save {preview === 'model' ? design.modelTextured ? 'textured GLB' : 'GLB geometry' : 'reference PNG'}</button>}
        <button className="text-button" disabled={locked} onClick={() => { setRequest({ ...design.request, title: design.title }); setInput(design.request.referenceId ? 'image' : 'text'); setId(''); setNotice('Brief copied. Change the seed or descriptions, then create a new concept.'); setError('') }}><Plus size={14} /> Use brief for variation</button>
      </div>}
      {design && <p className="fine-print">Generate again after changing the brief, seed or saved model choices. Reruns create a saved variation and keep only the references needed for that stage; earlier outputs and Animator characters stay unchanged. Identical settings and seeds may reproduce the same result.</p>}
      <div className="design-limits"><ShieldCheck size={17} /><p>Review each stage before continuing. 3D uses only the validated T-pose foreground, not the original scene. Hunyuan3D produces geometry only; TRELLIS.2 generates new geometry plus embedded textures from the same reference. It does not repaint an existing Hunyuan mesh. Both are <strong>unrigged</strong>. Review unseen surfaces, texture seams, anatomy and hands before Animator.</p></div>
    </main>
    <aside id="designer-model-profiles" className="design-models" aria-label="Designer model profiles" hidden={!modelsOpen}>
      <div className="section-heading"><span className="section-kicker">LOCAL MODEL PROFILES</span><button aria-label="Refresh designer models" disabled={checking || locked} onClick={() => void refresh()}><RefreshCw size={14} className={checking ? 'spin' : ''} /></button></div>
      <h2>Built around your GPU</h2>
      <div className="design-hardware">
        {ready?.devices.map(device => <div key={device.name}><strong>{device.freeGB.toFixed(1)} GB available</strong><p>{device.totalGB.toFixed(1)} GB reported total</p><small>{device.name}</small></div>)}
        {!ready && <p>{checking ? 'Reading local ComfyUI hardware...' : 'Start local ComfyUI, then refresh models.'}</p>}
        {ready && !ready.devices.length && <p>No supported GPU reported. CPU-only generation is not supported.</p>}
      </div>
      {config && <>
        <label className="field-label" htmlFor="image-profile">Image model family</label>
        <select id="image-profile" disabled={locked} value={config.imageProfile} onChange={e => setConfig({ ...config, imageProfile: e.target.value as DesignerConfig['imageProfile'], checkpoint: '', controlnet: '', ipadapter: '', clipVision: '' })}>
          {Object.entries(imageProfiles).map(([key, profile]) => <option key={key} value={key}>{profile.label} / ~{profile.gb} GB{ready && free < profile.gb ? ' / low memory' : ''}</option>)}
        </select>
        <p className="fine-print">{imageProfiles[config.imageProfile].size}px scene references. {config.imageProfile === 'sd15' ? 'Lower-memory option; use an SD 1.5 checkpoint such as DreamShaper 8.' : 'Higher-resolution option; requires an SDXL checkpoint.'}</p>
        <label className="field-label" htmlFor="image-checkpoint">Installed image checkpoint</label>
        <select id="image-checkpoint" disabled={locked} value={config.checkpoint} onChange={e => setConfig({ ...config, checkpoint: e.target.value })}>
          <option value="">Select compatible local weights</option>
          {config.checkpoint && !ready?.checkpoints.includes(config.checkpoint) && <option value={config.checkpoint}>{config.checkpoint} (unavailable)</option>}
          {ready?.checkpoints.filter(name => !/hunyuan|flux|sd3/i.test(name)).map(name => <option key={name}>{name}</option>)}
        </select>
        <div className="panel-rule" />
        <h2>T-pose image editing</h2>
        <p className="fine-print">{tposeEditProfile.label}. Edits the scene character instead of re-generating the brief. About {tposeEditProfile.gb + 2} GB available GPU memory including background removal; {tposeEditProfile.steps} distilled steps. No SD/OpenPose fallback.</p>
        {([
          { key: 'editModel', label: 'T-pose edit model', names: ready?.diffusionModels ?? [] },
          { key: 'editTextEncoder', label: 'Edit text encoder', names: ready?.textEncoders ?? [] },
          { key: 'editVae', label: 'Edit autoencoder', names: ready?.vaes ?? [] }
        ] as const).map(({ key, label, names }) => <div key={key}>
          <label className="field-label" htmlFor={`design-${key}`}>{label}</label>
          <select id={`design-${key}`} disabled={locked} value={config[key] ?? ''} onChange={e => setConfig({ ...config, [key]: e.target.value })}>
            <option value="">Select installed local weights</option>
            {config[key] && !names.includes(config[key]) && <option value={config[key]}>{config[key]} (unavailable)</option>}
            {names.map(name => <option key={name}>{name}</option>)}
          </select>
        </div>)}
        <label className="field-label" htmlFor="design-background">Background removal <span>required for T-pose</span></label>
        <select id="design-background" disabled={locked} value={config.backgroundModel ?? ''} onChange={e => setConfig({ ...config, backgroundModel: e.target.value })}>
          <option value="">Select local BiRefNet weights</option>
          {config.backgroundModel && !ready?.backgroundModels.includes(config.backgroundModel) && <option value={config.backgroundModel}>{config.backgroundModel} (unavailable)</option>}
          {ready?.backgroundModels.map(name => <option key={name}>{name}</option>)}
        </select>
        <p className="fine-print">Removes all background while retaining character colors. Produces a transparent PNG; opaque or border-touching masks cannot feed 3D. Budget about 2 GB extra for segmentation.</p>
        <div className="panel-rule" />
        <label className="field-label" htmlFor="design-ipadapter">Scene reference adapter <span>optional</span></label>
        <select id="design-ipadapter" disabled={locked} value={config.ipadapter ?? ''} onChange={e => setConfig({ ...config, ipadapter: e.target.value, ...(e.target.value ? {} : { clipVision: '' }) })}>
          <option value="">Basic img2img (no adapter)</option>
          {config.ipadapter && !ready?.ipadapters.includes(config.ipadapter) && <option value={config.ipadapter}>{config.ipadapter} (unavailable)</option>}
          {ready?.ipadapters.map(name => <option key={name}>{name}</option>)}
        </select>
        {config.ipadapter && <><label className="field-label" htmlFor="design-clipvision">Adapter CLIP Vision</label>
          <select id="design-clipvision" disabled={locked} value={config.clipVision ?? ''} onChange={e => setConfig({ ...config, clipVision: e.target.value })}>
            <option value="">Select compatible local vision weights</option>
            {config.clipVision && !ready?.clipVision.includes(config.clipVision) && <option value={config.clipVision}>{config.clipVision} (unavailable)</option>}
            {ready?.clipVision.map(name => <option key={name}>{name}</option>)}
          </select></>}
        <p className="fine-print">Optional for scene generation from an image, not used for T-pose editing. Requires an SD 1.5/SDXL adapter matching the scene model and compatible CLIP Vision weights; budget about 2 GB extra GPU memory.</p>
        <div className="panel-rule" />
        <label className="field-label" htmlFor="mesh-profile">3D model profile</label>
        <select id="mesh-profile" disabled={locked} value={config.meshProfile} onChange={e => setConfig({ ...config, meshProfile: e.target.value as DesignerConfig['meshProfile'], meshCheckpoint: '' })}>
          {Object.entries(meshProfiles).map(([key, profile]) => <option key={key} value={key}>{profile.label} / ~{profile.gb} GB{ready && free < profile.gb ? ' / low memory' : ''}</option>)}
        </select>
        {config.meshProfile === 'textured' ? <>
          <p className="fine-print">Generates a new textured model from the T-pose with a base-color/metallic/roughness atlas. Standard runs one 512 shape pass; High and Maximum add a 1024 or 1536 shape refinement pass for sharper faces, hands and folds. Higher detail, larger textures and more faces increase generation time, memory use, file size and later rigging time. Fixed 12/20/12 structure/shape/texture steps plus 12 refinement steps. Experimental native backend support; missing weights or textures are errors, not geometry-only fallbacks.</p>
          <label className="field-label" htmlFor="design-mesh-detail">3D shape detail</label>
          <select id="design-mesh-detail" disabled={locked} value={quality.shapeDetail} onChange={e => setConfig({ ...config, meshShapeDetail: Number(e.target.value) as MeshShapeDetail })}>
            {meshQualityOptions.shapeDetail.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label className="field-label" htmlFor="design-texture-size">3D texture size</label>
          <select id="design-texture-size" disabled={locked} value={quality.textureSize} onChange={e => setConfig({ ...config, meshTextureSize: Number(e.target.value) as MeshTextureSize })}>
            {meshQualityOptions.textureSize.map(size => <option key={size} value={size}>{size / 1024}K atlas ({size} x {size})</option>)}
          </select>
          <label className="field-label" htmlFor="design-face-count">3D target face count</label>
          <select id="design-face-count" disabled={locked} value={quality.faceCount} onChange={e => setConfig({ ...config, meshFaceCount: Number(e.target.value) })}>
            {[...new Set([...meshQualityOptions.faceCount, quality.faceCount])].sort((a, b) => a - b).map(count => <option key={count} value={count}>{count.toLocaleString()} faces</option>)}
          </select>
          {([
            { key: 'meshTextureModel', label: 'Textured 3D model', names: ready?.diffusionModels ?? [] },
            { key: 'meshVision', label: '3D vision encoder', names: ready?.clipVision ?? [] },
            { key: 'meshShapeVae', label: '3D shape decoder', names: ready?.vaes ?? [] },
            { key: 'meshTextureVae', label: '3D texture decoder', names: ready?.vaes ?? [] }
          ] as const).map(({ key, label, names }) => <div key={key}>
            <label className="field-label" htmlFor={`design-${key}`}>{label}</label>
            <select id={`design-${key}`} disabled={locked} value={config[key] ?? ''} onChange={e => setConfig({ ...config, [key]: e.target.value })}>
              <option value="">Select installed local weights</option>
              {config[key] && !names.includes(config[key]) && <option value={config[key]}>{config[key]} (unavailable)</option>}
              {names.map(name => <option key={name}>{name}</option>)}
            </select>
          </div>)}
        </> : <><label className="field-label" htmlFor="mesh-checkpoint">Installed 3D checkpoint</label>
        <select id="mesh-checkpoint" disabled={locked} value={config.meshCheckpoint} onChange={e => setConfig({ ...config, meshCheckpoint: e.target.value })}>
          <option value="">Select single-view Hunyuan3D 2 weights</option>
          {config.meshCheckpoint && !ready?.checkpoints.includes(config.meshCheckpoint) && <option value={config.meshCheckpoint}>{config.meshCheckpoint} (unavailable)</option>}
          {ready?.checkpoints.filter(name => /hunyuan/i.test(name)).map(name => <option key={name}>{name}</option>)}
        </select></>}
        <div className="panel-rule" />
        <label className="field-label" htmlFor="title-model">Automatic title model <span>CPU</span></label>
        <select id="title-model" disabled={locked} value={config.titleModel} onChange={e => setConfig({ ...config, titleModel: e.target.value })}>
          <option value="">Use a title I provide</option>
          {config.titleModel && !ready?.titleModels.includes(config.titleModel) && <option value={config.titleModel}>{config.titleModel} (unavailable)</option>}
          {ready?.titleModels.map(name => <option key={name}>{name}</option>)}
        </select>
        {ready?.titleError && <p className="fine-print">{ready.titleError}</p>}
        <p className="fine-print">Optional Ollama on 127.0.0.1:11434. A small local instruction model (for example Qwen 2.5 3B) names untitled characters; cloud models are rejected.</p>
        <button className="secondary full" disabled={locked || !settingsDirty} onClick={() => void perform(async () => { await window.studio.designerSettings(config); setNotice('Local model choices saved.') })}><Check size={15} /> Save model choices</button>
        {settingsDirty && <p className="fine-print">Save model choices before generating. Completed image stages keep their original model family.</p>}
      </>}
      <details className="design-setup"><summary>Model setup & offline requirements</summary><p>Missing-model errors offer Download required models for BiRefNet, FLUX.2 klein editing, DreamShaper 8 / SDXL, standard Hunyuan3D 2 and TRELLIS.2. Approve the size and source, then Studio verifies, refreshes and selects the required files. Retry generation yourself after setup. Other checkpoints, optional IP-Adapter and Ollama still need manual setup. No Python packages are changed.</p><p>Scene/Hunyuan checkpoints go in models\checkpoints. T-pose edits use flux-2-klein-4b-fp8.safetensors in models\diffusion_models, qwen_3_4b.safetensors in models\text_encoders, flux2-vae.safetensors in models\vae, and BiRefNet in models\background_removal.</p><p>Use native single-view Hunyuan3D 2 / 2mini safetensors with names identifying the model and mini variant. Turbo, multiview and 2.1 checkpoints are not supported by these profiles. 2mini weights must be installed manually; downloads never silently switch profiles.</p><p>Textured generation uses {meshTextureProfile.model} in models\diffusion_models, {meshTextureProfile.vision} in models\clip_vision, and {meshTextureProfile.shapeVae} plus {meshTextureProfile.textureVae} in models\vae. These total about 8.5 GB. ComfyUI must include native TRELLIS.2, remeshing, UV unwrapping and texture-baking nodes.</p><p>Memory budgets are conservative estimates, not compatibility guarantees. GPU architecture, free system RAM, drivers and checkpoint precision also matter. Stages and Animator jobs run sequentially.</p></details>
      <button className="text-button full" onClick={onSettings}>Backend connections</button>
    </aside>
  </div>
}
