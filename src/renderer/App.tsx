import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Check as CheckIcon, ChevronDown, CircleAlert, Clapperboard, FolderOpen, Layers3, ListChecks, LoaderCircle, Plus, Settings2, ShieldCheck, Sparkles, X, Zap, Box, Bone, SlidersHorizontal, RefreshCw, WandSparkles } from 'lucide-react'
import type { Character, Check, Job, RigSetup, SkinningMode, Settings, Snapshot, Vec3 } from '../shared/types'
import { Viewport } from './Viewport'
import { LibraryPanel } from './LibraryPanel'
import { DesignerPanel } from './DesignerPanel'
import { MocapPanel } from './MocapPanel'
import { SetupWizard } from './SetupWizard'
import { FileDialog } from './FileDialog'
import { LaunchCheck } from './LaunchCheck'
import { defaultLandmarks } from '../shared/rig'
import { AiProvidersPanel, AiRouteBadge } from './AiProvidersPanel'
import { AiConsent } from './AiConsent'
import type { AiStage } from '../shared/ai'
import type { ProcessStep } from '../shared/workspace'
import { WorkspaceLayout, ProcessStepper } from './WorkspaceLayout'

const done = new Set(['complete', 'failed', 'cancelled'])
const explain = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpChanging, setMcpChanging] = useState(false)
  const [workspace, setWorkspace] = useState<'designer' | 'animator' | 'mocap'>('animator')
  const [animatorStep, setAnimatorStep] = useState<'import' | 'fit' | 'motion' | 'export'>('import')
  const [designerStage, setDesignerStage] = useState<AiStage>('scene')
  const [characterId, setCharacterId] = useState('')
  const [setup, setSetup] = useState<RigSetup>({ rotation: [0, 0, 0], landmarks: defaultLandmarks() })
  const [dirty, setDirty] = useState(false)
  const [fit, setFit] = useState(false)
  const [selected, setSelected] = useState('Hips')
  const [mirror, setMirror] = useState(true)
  const [jobId, setJobId] = useState('')
  const [animationPart, setAnimationPart] = useState<'path' | 'clip' | 'transition'>('path')
  const [mode, setMode] = useState<'input' | 'rig' | 'animation'>('input')
  const [prompt, setPrompt] = useState('A person walks forward at a relaxed pace.')
  const [seconds, setSeconds] = useState(5)
  const [seed, setSeed] = useState(42)
  const [steps, setSteps] = useState(100)
  const [inPlace, setInPlace] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [providerStage, setProviderStage] = useState<AiStage>()
  const [providerField, setProviderField] = useState<string>()
  const [settings, setSettings] = useState<Settings>()
  const [checks, setChecks] = useState<Check[]>([])
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryNew, setLibraryNew] = useState(false)
  const [parentJobId, setParentJobId] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  const [launchCheck, setLaunchCheck] = useState(false)
  const character = snapshot?.characters.find(c => c.id === characterId)
  const latestRig = snapshot?.jobs.find(j => j.characterId === characterId && j.kind === 'rig')
  const skinningFailed = latestRig?.stage === 'failed' && (latestRig.rigFailure === 'unweighted' || latestRig.message.includes('vertices unweighted'))
  const jobs = snapshot?.jobs.filter(j => j.characterId === characterId && j.kind === 'generate') ?? []
  const completed = jobs.filter(j => j.stage === 'complete')
  const takes = snapshot?.jobs.filter(j => j.characterId === characterId && (j.kind === 'generate' || j.kind === 'mocap')) ?? []
  const output = takes.find(j => j.id === jobId && j.stage === 'complete')
  const active = snapshot?.jobs.find(j => !done.has(j.stage))
  const activeCharacterJob = active?.characterId === characterId ? active : undefined
  const activeBatch = snapshot?.batches.find(b => b.status === 'running')
  const locked = busy || !!active || !!activeBatch || !!snapshot?.designer?.designs.some(d => d.status === 'running') || snapshot?.designer?.modelDownload?.status === 'running'
  const blocked = checks.filter(c => c.status === 'blocked')
  const animationUrl = animationPart === 'clip' ? output?.clipPreviewUrl : animationPart === 'transition' ? output?.transitionPreviewUrl : output?.previewUrl
  const url = mode === 'animation' ? animationUrl : mode === 'rig' ? character?.rigPreviewUrl : character?.previewUrl

  async function refreshChecks() {
    if (!window.studio) return
    setChecking(true)
    try { setChecks(await window.studio.check()) } catch (e) { setError(explain(e)) } finally { setChecking(false) }
  }
  useEffect(() => {
    if (!window.studio) { setError('The native desktop bridge is unavailable. Start CharacterStudio.exe or run npm run dev.'); return }
    window.studio.desktopControlEnabled().then(setMcpEnabled).catch(e => setError(explain(e)))
    window.studio.snapshot().then(s => {
      setSnapshot(s); setSettings(s.settings)
      if (s.characters.length) selectCharacter(s.characters[0])
    }).catch(e => setError(explain(e)))
    const remove = window.studio.onUpdate(setSnapshot)
    window.studio.setupState().then(state => { if (state.firstLaunch || state.showOnLaunch) setSetupOpen(true); else if (state.checkOnLaunch) setLaunchCheck(true) }).catch(e => setError(explain(e)))
    const removeMcp = window.studio.onDesktopControlChanged(setMcpEnabled)
    void refreshChecks()
    return () => { remove(); removeMcp() }
  }, [])
  function closeSetup() {
    setSetupOpen(false)
    reloadAfterSetup()
  }
  function reloadAfterSetup() {
    window.studio.snapshot().then(s => { setSnapshot(s); setSettings(s.settings) }).catch(e => setError(explain(e)))
    void refreshChecks()
  }

  function selectCharacter(c: Character) {
    setCharacterId(c.id); setSetup(structuredClone(c.setup)); setDirty(false)
    setMode(c.rigged ? 'rig' : 'input'); setFit(!c.rigged); setAnimatorStep(c.rigged ? 'motion' : 'fit'); setJobId(''); setParentJobId(''); setAnimationPart('path')
  }
  function openProviders(stage: AiStage = workspace === 'designer' ? designerStage : workspace === 'mocap' ? 'capture' : 'motion', field?: string) {
    setSettingsOpen(false)
    setProviderStage(stage); setProviderField(field)
  }
  function selectAnimatorStep(step: string) {
    if (step !== 'import' && step !== 'fit' && step !== 'motion' && step !== 'export') return
    setAnimatorStep(step); setFit(step === 'fit')
    if (step === 'import' || step === 'fit') setMode('input')
    if (step === 'export' && output) setMode('animation')
  }
  async function perform(action: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }
  async function importFbx() {
    await perform(async () => { const c = await window.studio.importCharacter(); if (c) { selectCharacter(c); setFit(true) } })
  }
  function move(name: string, position: Vec3) {
    if (locked) return
    setSetup(old => {
      const landmarks = { ...old.landmarks, [name]: position }
      if (mirror && /^(Left|Right)/.test(name)) {
        const other = name.startsWith('Left') ? name.replace('Left', 'Right') : name.replace('Right', 'Left')
        landmarks[other] = [-position[0], position[1], position[2]]
      }
      return { ...old, landmarks }
    })
    setDirty(true)
  }
  async function saveFit() {
    if (!character) return
    const updated = await window.studio.saveSetup(character.id, setup)
    setSetup(updated.setup); setDirty(false)
  }
  async function autoFit() {
    if (!character) return
    await perform(async () => {
      const fitted = await window.studio.fitLandmarks(character.id, setup.rotation).catch(e => {
        throw new Error(`Auto-fit could not place the joints: ${explain(e)} Your current landmarks were kept.`)
      })
      setSetup(old => ({ ...old, landmarks: fitted.landmarks })); setDirty(true)
      setNotice(['Landmarks fitted to the mesh. Review them in the front and side views before building the rig.', ...fitted.warnings].join(' '))
    })
  }
  async function createRig(skinning: SkinningMode = 'automatic') {
    if (!character) return
    await perform(async () => {
      if (dirty) await saveFit()
      await window.studio.rig(character.id, skinning)
      const updated = await window.studio.snapshot()
      setSnapshot(updated)
      setMode('rig'); setFit(false); setAnimatorStep('motion'); setNotice('Skin weights validated. Review the rig notes and inspect joint bending before using or exporting motion.')
    })
  }
  async function generate() {
    if (!character) return
    await perform(async () => {
      await window.studio.generate({ characterId: character.id, prompt, seconds, seed, steps, inPlace, parentJobId: parentJobId || undefined })
      const s = await window.studio.snapshot()
      setSnapshot(s)
      const latest = s.jobs.find(j => j.characterId === character.id && j.kind === 'generate' && j.stage === 'complete')
      if (latest) { setJobId(latest.id); setMode('animation'); setFit(false); setAnimatorStep('export'); setAnimationPart('path') }
    })
  }
  const stages: ProcessStep[] = [
    { id: 'import', label: 'Import character', complete: !!character },
    { id: 'fit', label: 'Fit & skin', complete: !!character?.rigged && !dirty,
      state: activeCharacterJob?.kind === 'rig' ? 'running' : latestRig?.stage === 'failed' ? 'failed' : latestRig?.stage === 'cancelled' ? 'cancelled' : !character ? 'blocked' : undefined },
    { id: 'motion', label: 'Generate motion', complete: completed.length > 0,
      state: activeCharacterJob?.kind === 'generate' ? 'running' : jobs[0]?.stage === 'failed' ? 'failed' : jobs[0]?.stage === 'cancelled' ? 'cancelled' : !character?.rigged || dirty ? 'blocked' : undefined },
    { id: 'export', label: 'Review & export', state: !output ? 'blocked' : undefined }
  ]
  return <div className="app">
    <header className="topbar">
      <div className="brand"><img className="brand-mark" src="./icon.png" alt="" width={48} height={48} /><div className="brand-name"><strong>character<span>studio</span></strong></div></div>
      <nav className="workspace-tabs" role="tablist" aria-label="Character workspace" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const order = ['designer', 'animator', 'mocap'] as const
        const index = order.indexOf(workspace)
        const next = event.key === 'Home' ? 'designer' : event.key === 'End' ? 'mocap' : order[(index + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]
        setWorkspace(next)
        document.getElementById(`${next}-tab`)?.focus()
      }}>
        <button id="designer-tab" role="tab" tabIndex={workspace === 'designer' ? 0 : -1} aria-selected={workspace === 'designer'} aria-controls="designer-panel" className={workspace === 'designer' ? 'active' : ''} onClick={() => setWorkspace('designer')}>Designer</button>
        <span className="module-divider" aria-hidden="true">|</span>
        <button id="animator-tab" role="tab" tabIndex={workspace === 'animator' ? 0 : -1} aria-selected={workspace === 'animator'} aria-controls="animator-panel" className={workspace === 'animator' ? 'active' : ''} onClick={() => setWorkspace('animator')}>Animator</button>
        <span className="module-divider" aria-hidden="true">|</span>
        <button id="mocap-tab" role="tab" tabIndex={workspace === 'mocap' ? 0 : -1} aria-selected={workspace === 'mocap'} aria-controls="mocap-panel" className={workspace === 'mocap' ? 'active' : ''} onClick={() => setWorkspace('mocap')}>Mocap</button>
      </nav>
      <div className="topbar-actions"><button className="connection" aria-label="Model Settings" aria-haspopup="dialog" onClick={() => openProviders()}><Settings2 size={14} /> Model Settings</button>
      <button aria-label="Setup checklist" title="Setup checklist" className="connection icon-only" onClick={() => setSetupOpen(true)}><ListChecks size={16} /></button>
      <button aria-label="Backend connections" className={`connection ${blocked.length ? 'warning' : ''}`} onClick={() => setSettingsOpen(true)}><span className="tiny-dot" />{checking ? 'Checking backends' : blocked.length ? 'Setup needs attention' : checks.length ? 'Local backends ready' : 'Backend settings'}<Settings2 size={14} /></button></div>
    </header>
    {snapshot && <DesignerPanel snapshot={snapshot} visible={workspace === 'designer'} animatorBusy={busy || !!active || !!activeBatch} onSettings={() => setSettingsOpen(true)} onProviders={openProviders} onStep={setDesignerStage} onAnimate={c => { selectCharacter(c); selectAnimatorStep('fit'); setWorkspace('animator') }} />}
    {snapshot && <MocapPanel snapshot={snapshot} visible={workspace === 'mocap'} animatorBusy={busy} onProviders={openProviders} onReviewFit={c => { selectCharacter(c); selectAnimatorStep('fit'); setWorkspace('animator') }}
      onOpenAnimator={(c, job) => { selectCharacter(c); setJobId(job); setMode('animation'); setFit(false); setAnimatorStep('export'); setAnimationPart('path'); setWorkspace('animator') }} />}
    <WorkspaceLayout id="animator-panel" labelledBy="animator-tab" hidden={workspace !== 'animator'} step={animatorStep}>
      <aside className="workflow-settings" aria-label="Animator step settings">
        <div className="section-kicker">YOUR WORKSPACE</div><h1>Character lab</h1>
        <section hidden={animatorStep !== 'import'}>
        <p className="intro">Import a character, review the fit, then direct the motion.</p>
        <button className="import-button" disabled={locked} onClick={importFbx}><Plus size={18} /> Import FBX <span>LOCAL FILE</span></button>
        <button className="text-button full" disabled={locked} onClick={() => void perform(async () => { const characters = await window.studio.importCollection(); if (characters[0]) selectCharacter(characters[0]) })}><FolderOpen size={14} /> Import FBX collection</button>
        </section>
        <details className="workspace-collection" open={animatorStep === 'import'}><summary>Characters ({snapshot?.characters.length ?? 0}){character ? ` · ${character.name}` : ''}</summary>
        <div className="asset-list">
          {snapshot?.characters.map(c => <button className={`asset ${c.id === characterId ? 'active' : ''}`} key={c.id} disabled={locked} onClick={() => selectCharacter(c)}>
            <span className="asset-icon"><PersonIcon /></span><span><strong>{c.name}</strong><small>{c.rigged ? 'Skinned humanoid' : 'Unrigged import'} · {Math.round(c.vertices / 1000)}k verts</small></span>
          </button>)}
          {!snapshot?.characters.length && <div className="empty-assets"><FolderOpen size={24} /><p>No characters yet</p><small>Your imported files stay on this PC.</small></div>}
        </div>
        {character && <div className="asset-detail"><span>{character.meshes} MESH{character.meshes !== 1 ? 'ES' : ''}</span><span>2m WORKING SCALE</span></div>}
        </details>
        <button className="text-button data-button" onClick={() => void perform(() => window.studio.revealData())}><FolderOpen size={14} /> Open workspace files</button>
        <section aria-label="Animator motion controls" hidden={animatorStep === 'import' || animatorStep === 'export'}>
        {animatorStep === 'fit' ? character ? <>
          <div className="section-kicker">02 / PREPARE CHARACTER</div><h2>Fit the humanoid rig</h2><p className="panel-description">Use a full-body T- or A-pose. Point the character forward (+Z), auto-fit the joints, then check that each joint sits inside the mesh.</p>
          <label className="field-label">Orientation <span>degrees</span></label>
          <div className="xyz-fields">{(['X', 'Y', 'Z'] as const).map((axis, i) => <label key={axis}>{axis}<select aria-label={`Rotate ${axis}`} disabled={locked} value={setup.rotation[i]} onChange={e => { const rotation = [...setup.rotation] as Vec3; rotation[i] = Number(e.target.value); setSetup({ ...setup, rotation }); setDirty(true) }}>{[-180, -90, 0, 90, 180].map(v => <option key={v} value={v}>{v}°</option>)}</select></label>)}</div>
          <label className="field-label" htmlFor="joint-select">Selected landmark</label>
          <select id="joint-select" value={selected} onChange={e => setSelected(e.target.value)}>{Object.keys(setup.landmarks).map(name => <option key={name}>{name}</option>)}</select>
          <div className="xyz-fields positions">{(['X', 'Y', 'Z'] as const).map((axis, i) => <label key={axis}>{axis}<input aria-label={`Joint ${axis}`} type="number" step="0.01" min="-4" max="4" value={Number(setup.landmarks[selected][i].toFixed(3))} disabled={locked} onChange={e => { const point = [...setup.landmarks[selected]] as Vec3; point[i] = Number(e.target.value); move(selected, point) }} /></label>)}</div>
          <label className="checkbox"><input type="checkbox" checked={mirror} onChange={e => setMirror(e.target.checked)} /> Mirror left / right joints</label>
          <div className="fit-instructions"><strong>Fit in two views</strong><p>Front: hips, knees, shoulders, elbows.<br />Side: joint depth, spine, toes.<br />White joint = selected. Drag its axis handles.</p></div>
          <button className="secondary full" disabled={locked} onClick={() => void autoFit()}><WandSparkles size={14} /> Auto-fit landmarks to mesh</button>
          <button className="text-button full" disabled={locked} onClick={() => { setSetup({ ...setup, landmarks: defaultLandmarks() }); setDirty(true) }}><RotateIcon /> Reset landmark template</button>
          {dirty && <button className="text-button full" disabled={locked} onClick={() => void perform(async () => { await saveFit(); setNotice('Fit saved. Rebuild the rig to apply these changes.') })}><CheckIcon size={14} /> Save fit without rigging</button>}
          <div className="rig-action-step">
            <strong>1. Try automatic rigging first</strong>
            <p>Build a skinned rig from these points. If it fails or the joints bend poorly, adjust the points and use step 2.</p>
            <button className="primary full" disabled={locked} onClick={() => void createRig()}><Bone size={17} /> Try auto-rigging<ArrowRight size={17} /></button>
          </div>
          {skinningFailed && <div className="fit-instructions rig-failure" role="status"><strong>Automatic rigging could not attach all vertices</strong><p>Move the landmarks in the viewport, then choose “Use adjusted points + fallback skinning” below. Your adjusted points will be saved with that attempt; no incomplete rig was accepted.</p></div>}
          <div className="rig-action-step rig-fallback-step">
            <strong>2. If automatic rigging fails</strong>
            <p>Manually move the landmarks in the viewport, then use fallback skinning with the adjusted points.</p>
            <button className="secondary full rig-fallback-button" disabled={locked} onClick={() => void createRig('fallback')}><CheckIcon size={17} /> Use adjusted points + fallback skinning</button>
          </div>
          <p className="fine-print">Fallback attaches remaining vertices to nearby fitted bones; touching limbs or separate pieces may bend incorrectly. Complete weights are still required. Body only, not fingers or face.</p>
        </> : <p className="panel-description">Import or select a character before fitting its rig.</p> : <>
          <div className="section-kicker">03 / DIRECT THE MOTION</div><h2>What’s the move?</h2><p className="panel-description">Describe a movement. The selected motion provider generates SOMA motion; local Blender applies it to your character.</p>
          {snapshot && <AiRouteBadge snapshot={snapshot} stage="motion" onClick={() => openProviders('motion')} />}
          <label htmlFor="motion-prompt" className="field-label">Motion instructions <Sparkles size={13} /></label>
          <div className="prompt-field"><textarea id="motion-prompt" value={prompt} disabled={locked} maxLength={1000} onChange={e => setPrompt(e.target.value)} placeholder="A person waves with their right hand…" /><span>{prompt.length} / 1000</span></div>
          <div className="prompt-suggestions">{['Walk forward', 'Wave hello', 'Look around'].map((text, i) => <button disabled={locked} key={text} onClick={() => setPrompt(['A person walks forward at a relaxed pace.', 'A person stands and waves hello with their right hand.', 'A person stands and slowly looks around.'][i])}>{text}</button>)}</div>
          <button className="text-button full" disabled={locked} onClick={() => { setLibraryNew(true); setLibraryOpen(true) }}><Layers3 size={14} /> Save this configuration</button>
          {completed.length > 0 && <><label className="field-label" htmlFor="branch-parent">Start from an existing take</label><select id="branch-parent" disabled={locked} value={parentJobId} onChange={e => { setParentJobId(e.target.value); const parent = completed.find(j => j.id === e.target.value); if (parent) setInPlace(parent.inPlace ?? false) }}><option value="">New independent motion</option>{completed.map(j => <option value={j.id} key={j.id}>{j.label || j.prompt}</option>)}</select>{parentJobId && <p className="fine-print">Conditioned on the parent's final full-body pose. Export includes the parent and new motion as one branch.</p>}</>}
          <div className="panel-rule" />
          <div className="two-fields"><label>Duration / segment<div className="unit-input"><input aria-label="Duration seconds" disabled={locked} type="number" min="0.5" max="30" step="0.5" value={seconds} onChange={e => setSeconds(Number(e.target.value))} /><span>sec</span></div></label><label>Seed<input aria-label="Motion seed" disabled={locked} type="number" min="0" max="4294967295" value={seed} onChange={e => setSeed(Number(e.target.value))} /></label></div>
          <details className="model-advanced"><summary>Advanced generation</summary><label className="field-label" htmlFor="steps">Denoising steps <span>quality</span></label><select id="steps" disabled={locked} value={steps} onChange={e => setSteps(Number(e.target.value))}><option value="25">25 — quick draft</option><option value="50">50 — balanced</option><option value="100">100 — standard</option><option value="200">200 — detailed</option></select></details>
          <label className="checkbox"><input disabled={locked || !!parentJobId} type="checkbox" checked={inPlace} onChange={e => setInPlace(e.target.checked)} /> Keep root in place</label>
          <p className="fine-print">Periods create separate motion segments. Playback loops the clip; seamless looping is not guaranteed.</p>
          {!character?.rigged || dirty ? <button className="primary full" disabled={!character || locked} onClick={() => selectAnimatorStep('fit')}><SlidersHorizontal size={17} /> Fit character first<ArrowRight size={17} /></button> : <button className="primary full" disabled={locked || prompt.trim().length < 3} onClick={generate}><WandSparkles size={17} /> Generate animation<ArrowRight size={17} /></button>}
          {character?.rigged && !dirty && <button className="text-button full" disabled={locked} onClick={() => selectAnimatorStep('fit')}><Bone size={14} /> Adjust rig fit</button>}
          {!!blocked.length && <button className="setup-warning" onClick={() => setSettingsOpen(true)}><CircleAlert size={16} /><span>{blocked.some(c => c.name.includes('text encoder')) ? 'Set up the local text encoder' : `${blocked.length} backend check${blocked.length > 1 ? 's' : ''} need attention`}<small>Review setup before generation <ArrowRight size={11} /></small></span></button>}
        </>}
        </section>
        {!!character?.rigWarnings?.length && <details className="warnings" open><summary>Rig notes <ChevronDown size={13} /></summary>{character.rigWarnings.map(w => <p key={w}>{w}</p>)}</details>}
        {!!character?.warnings.length && <details className="warnings"><summary>Import notes <ChevronDown size={13} /></summary>{character.warnings.map(w => <p key={w}>{w}</p>)}</details>}
        <div className="output-section" hidden={animatorStep !== 'export'}>
          <div className="section-kicker">EXPORT CHARACTER</div>
          {output ? <><h3>Ready for your next scene.</h3>
            {output.clipPreviewUrl && <><label className="field-label" htmlFor="preview-part">Preview output</label><select id="preview-part" value={animationPart} onChange={e => { setAnimationPart(e.target.value as typeof animationPart); setMode('animation') }}><option value="path">Full path</option><option value="clip">Node clip</option>{output.transitionPreviewUrl && <option value="transition">Incoming transition</option>}</select><p className="fine-print">{output.graphContext?.pathLabel}</p></>}
            {output.kind === 'generate' && <button className="text-button full" disabled={locked} onClick={() => { setParentJobId(output.id); setInPlace(output.inPlace ?? false); selectAnimatorStep('motion'); setNotice('Next generation will branch from this take’s final pose.') }}>Branch from this take <ArrowRight size={13} /></button>}{output.outputFiles?.map(file => <button key={file} className="download" onClick={() => void perform(async () => { const path = await window.studio.saveOutput(output.id, file); if (path) setNotice(`Saved ${path}`) })}><ArrowDownToLine size={16} /><span>{outputLabel(file)}</span></button>)}{output.warnings?.map(w => <p className="fine-print" key={w}>{w}</p>)}</> : <><div className="export-disabled"><ArrowDownToLine size={18} /><span>Animated GLB + FBX</span></div><p className="fine-print">Available after a completed, validated character animation. Select a completed take below the viewport. A skeleton alone is not an animated character.</p></>}
        </div>
        <button className="secondary full library-button" onClick={() => { setLibraryNew(false); setLibraryOpen(true) }}><Layers3 size={15} /> Motion library & batches</button>
      </aside>
      <main className="workflow-main" aria-label="Animator scene">
        <ProcessStepper label="Animator process" steps={stages} current={animatorStep} onSelect={selectAnimatorStep} />
        <div className="scene-heading">
          <div><span className="section-kicker">SCENE</span><h2>{character?.name.replace(/\.fbx$/i, '') ?? 'Untitled character'}<span className="file-tag">{mode === 'animation' ? 'ANIMATED' : character?.rigged && !dirty ? 'RIGGED' : 'FBX'}</span></h2></div>
          <div className="view-tabs">
            <button aria-pressed={mode === 'input'} className={mode === 'input' ? 'active' : ''} disabled={!character || locked} onClick={() => { setMode('input'); setFit(animatorStep === 'fit') }}>Original</button>
            <button aria-pressed={mode === 'rig'} className={mode === 'rig' ? 'active' : ''} disabled={!character?.rigged || dirty || locked} onClick={() => { setMode('rig'); setFit(false) }}>Rigged</button>
            <button aria-pressed={mode === 'animation'} className={mode === 'animation' ? 'active' : ''} disabled={!output || locked} onClick={() => { setMode('animation'); setFit(false) }}>Animation</button>
          </div>
        </div>
        <Viewport url={url} setup={setup} fit={fit && mode === 'input' && !locked && !!character} kind={mode} selected={selected} onSelect={setSelected} onMove={move} />
        {(active || activeBatch) && <div className="job-progress" role="status"><LoaderCircle size={17} className="spin" /><div><strong>{activeBatch ? `BATCH · ${activeBatch.items.filter(i => i.status === 'complete').length}/${activeBatch.items.length}` : active!.stage.toUpperCase()}</strong><p>{active?.message ?? 'Checking batch prerequisites'}</p><div className="progress-track"><span style={{ width: `${active?.progress ?? 5}%` }} /></div></div><button onClick={() => void window.studio.cancel().catch(e => setError(explain(e)))}>Cancel</button></div>}
        {error && <div className="banner error" role="alert"><CircleAlert size={18} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div className="banner success" role="status"><CheckIcon size={18} /><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={16} /></button></div>}
        <section className="takes">
          <div className="section-heading"><div><span className="section-kicker">MOTION TAKES</span><span className="count">{takes.length}</span></div><small>Saved automatically on this PC</small></div>
          {!takes.length ? <div className="no-takes"><span className="take-placeholder"><Sparkles size={19} /></span><div><strong>A new move starts with a few words.</strong><p>Generated takes will appear here, ready to preview and export.</p></div></div> :
            <div className="take-list">{takes.map(job => <button key={job.id} disabled={job.stage !== 'complete' || locked} className={`take ${jobId === job.id ? 'selected' : ''} ${job.stage}`} onClick={() => { setJobId(job.id); setMode('animation'); setFit(false); setAnimatorStep('export'); setAnimationPart('path') }}>
              <span className="take-icon">{job.stage === 'complete' ? job.kind === 'mocap' ? <Clapperboard size={17} /> : <Sparkles size={17} /> : job.stage === 'failed' ? <CircleAlert size={17} /> : <LoaderCircle size={17} />}</span><span><strong>{job.label || job.prompt || 'Motion take'}</strong><small>{job.stage === 'complete' ? job.kind === 'mocap' ? `Mocap · ${job.mocapOptions?.legs === 'lock' ? 'upper body · ' : ''}smoothing ${Math.round((job.mocapOptions?.smoothing ?? 0) * 100)}%` : `${job.parentJobId ? 'Full branch · ' : ''}${job.seconds}s / segment · seed ${job.seed}` : job.stage}</small>{job.stage === 'failed' && <small className="failure-text">{job.message}</small>}</span><span className="take-time">{new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </button>)}</div>}
        </section>
      </main>
    </WorkspaceLayout>
    <footer><span><ShieldCheck size={12} /> LOCAL FIRST</span><span>{workspace === 'designer' ? <>Character & scene <ArrowRight size={10} /> T-pose reference <ArrowRight size={10} /> 3D geometry <ArrowRight size={10} /> Animator</> : workspace === 'mocap' ? <>T-pose character <ArrowRight size={10} /> Reference video / webcam <ArrowRight size={10} /> Local pose capture <ArrowRight size={10} /> Animated FBX</> : <>FBX import <ArrowRight size={10} /> Blender rig + skin <ArrowRight size={10} /> Motion provider <ArrowRight size={10} /> Character export</>}</span><span>ARM64 READY</span></footer>
    {libraryOpen && snapshot && <LibraryPanel snapshot={snapshot} setup={setup} current={{ prompt, seconds, seed, steps, inPlace }} characterId={characterId} startNew={libraryNew} onClose={() => setLibraryOpen(false)} onProviders={() => openProviders('motion')} onApply={(node, savedFit) => {
      setPrompt(node.prompt); setSeconds(node.seconds); setSeed(node.seed); setSteps(node.steps); setInPlace(node.inPlace); setParentJobId('')
      if (savedFit && character) { setSetup({ ...structuredClone(savedFit), rotation: setup.rotation }); setDirty(true); selectAnimatorStep('fit') }
      else selectAnimatorStep('motion')
      setNotice('Prompt settings applied independently. Generate the saved graph to preserve incoming pose context, transitions and loop constraints.')
    }} onPreview={(id, job, part = 'path') => { const c = snapshot.characters.find(c => c.id === id); if (c) { selectCharacter(c); setJobId(job); setAnimationPart(part); setMode('animation'); setAnimatorStep('export'); setFit(false) } }} />}

    {settingsOpen && settings && <div className="modal-backdrop"><section className="settings-modal" role="dialog" aria-modal="true" aria-label="Local backend settings">
      <div className="modal-heading"><div><span className="section-kicker">LOCAL INFRASTRUCTURE</span><h2>Backend connections</h2></div><button aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={20} /></button></div>
      <p className="panel-description">Blender runs independently on CPU. The existing ComfyUI GPU environment is reused, never reinstalled or downgraded.</p>
      <h3>Agent control</h3>
      <label className="checkbox"><input type="checkbox" checked={mcpEnabled} disabled={mcpChanging} onChange={event => {
        const enabled = event.target.checked
        setMcpChanging(true); setError('')
        void window.studio.setDesktopControlEnabled(enabled).then(setMcpEnabled).catch(e => setError(explain(e))).finally(() => setMcpChanging(false))
      }} /> Enable MCP control</label>
      <p className="fine-print" role="status" aria-label="MCP control status">{mcpChanging ? 'Changing MCP control...' : mcpEnabled ? 'Enabled. Trusted local agents can operate this desktop.' : 'Disabled. MCP connections are blocked.'}</p>
      <p className="fine-print">This takes effect immediately and is saved independently of backend settings, even during a job. Only enable it for agents you trust with your local assets, settings and exports. Disabling disconnects MCP clients without cancelling running work; re-enabling requires clients to reconnect.</p>
      <h3>AI execution</h3>
      <button className="secondary full" onClick={() => openProviders()}>Model Settings</button>
      <p className="fine-print">Select local presets, custom workflows, remote ComfyUI or paid API providers per stage. The paths below remain local processing and download settings; they do not authorize remote execution.</p>
      <p className="fine-print">Kimodo encoder selection, memory guidance and model access instructions are in Model Settings under Motion.</p>
      <label className="field-label" htmlFor="comfy-url">ComfyUI API URL <span>loopback only</span></label><input id="comfy-url" value={settings.comfyUrl} onChange={e => setSettings({ ...settings, comfyUrl: e.target.value })} />
      {([['blenderPath', 'Blender executable', 'blender'], ['comfyRoot', 'ComfyUI backend folder', 'comfy'], ['comfyOutput', 'ComfyUI output folder', 'output']] as const).map(([key, label, kind]) => <div key={key}><label className="field-label" htmlFor={key}>{label}</label><div className="path-field"><input id={key} value={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.value })} /><button aria-label={`Browse ${label}`} onClick={() => void perform(async () => { const path = await window.studio.browse(kind); if (path) setSettings(old => old ? { ...old, [key]: path, ...(key === 'comfyRoot' ? { comfyOutput: path + '\\output' } : {}) } : old) })}><FolderOpen size={17} /></button></div></div>)}
      <div className="settings-actions"><button className="secondary" disabled={locked || starting} onClick={() => void perform(async () => { await window.studio.settings(settings); setNotice('Backend settings saved.'); await refreshChecks() })}><CheckIcon size={15} /> Save settings</button>
      <button className="primary" disabled={starting || locked} onClick={async () => { setStarting(true); setError(''); try { await window.studio.settings(settings); await window.studio.startComfy(); await refreshChecks() } catch (e) { setError(explain(e)) } finally { setStarting(false) } }}>{starting ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}{starting ? 'Starting ComfyUI…' : 'Start local ComfyUI'}</button></div>
      <div className="section-heading"><span className="section-kicker">READINESS CHECKS</span><button className="text-button" disabled={checking} onClick={refreshChecks}><RefreshCw size={13} className={checking ? 'spin' : ''} /> Refresh</button></div>
      <div className="checks">{checks.map(check => <div className={`check ${check.status}`} key={check.name}>{check.status === 'ready' ? <CheckIcon size={16} /> : <CircleAlert size={16} />}<div><strong>{check.name}</strong><p>{check.detail}</p></div></div>)}</div>
      {error && <p className="modal-error" role="alert">{error}</p>}
      <p className="fine-print">With built-in motion routes, both encoders run in local ComfyUI. LFM uses an explicit experimental Kimodo loader; it never falls back to Llama or remote inference. The original Llama loader uses TEXT_ENCODER_MODE=local when Studio starts ComfyUI; use that setting for an externally started backend. Configured remote motion uses the selected provider instead. Closing Studio stops only the local ComfyUI process it started.</p>
    </section></div>}
    {setupOpen && window.studio && <SetupWizard onClose={closeSetup} />}
    {launchCheck && !setupOpen && window.studio && <LaunchCheck onClose={() => { setLaunchCheck(false); reloadAfterSetup() }} onOpenChecklist={() => setSetupOpen(true)} />}
    {providerStage && snapshot && <AiProvidersPanel snapshot={snapshot} initialStage={providerStage} initialField={providerField} locked={locked} onClose={() => { setProviderStage(undefined); setSettings(snapshot.settings); void refreshChecks() }} />}
    <FileDialog />
    <AiConsent />
  </div>
}

function PersonIcon() { return <Box size={21} strokeWidth={1.3} /> }
function RotateIcon() { return <RefreshCw size={14} /> }
function outputLabel(file: string) {
  if (file === 'mocap-motion.json') return 'Solved mocap bone motion · JSON'
  if (file === 'landmarks.json') return 'Captured pose landmarks · JSON'
  const [name, extension] = file.split('.')
  const label = name === 'animated' ? 'Full character path' : name === 'clip' ? 'Character node clip' : name === 'transition' ? 'Incoming transition' : name === 'sequence' ? 'Full path motion only' : 'Node motion only'
  return `${label} · ${extension === 'blend' ? 'Blender' : extension.toUpperCase()}`
}
