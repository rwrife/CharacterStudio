import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Check as CheckIcon, ChevronDown, CircleAlert, FolderOpen, Layers3, LoaderCircle, Plus, Settings2, ShieldCheck, Sparkles, X, Zap, Box, Bone, SlidersHorizontal, RefreshCw, WandSparkles } from 'lucide-react'
import type { Character, Check, Job, RigSetup, Settings, Snapshot, Vec3 } from '../shared/types'
import { Viewport } from './Viewport'
import { LibraryPanel } from './LibraryPanel'
import { ModelSetupGuide } from './ModelSetupGuide'
import { DesignerPanel } from './DesignerPanel'
import { defaultLandmarks } from '../shared/rig'
import { recommendTextEncoder } from '../shared/text-encoder'

const done = new Set(['complete', 'failed', 'cancelled'])
const explain = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')
const humanOutline = 'M59.9 40.15A19.8 19.8 0 1 0 40.1 40.15Q41.2 44.5 34.5 46.5Q31.2 47.5 29.5 50.5L3.5 93.5A6.8 6.8 0 0 0 15.2 100.5L28.5 78.5L28.5 155.5A8.75 8.75 0 0 0 46 155.5L46 122A4 4 0 0 1 54 122L54 155.5A8.75 8.75 0 0 0 71.5 155.5L71.5 78.5L84.8 100.5A6.8 6.8 0 0 0 96.5 93.5L70.5 50.5Q68.8 47.5 65.5 46.5Q58.8 44.5 59.9 40.15Z'

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [workspace, setWorkspace] = useState<'designer' | 'animator'>('animator')
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
  const [settings, setSettings] = useState<Settings>()
  const [checks, setChecks] = useState<Check[]>([])
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryNew, setLibraryNew] = useState(false)
  const [parentJobId, setParentJobId] = useState('')
  const character = snapshot?.characters.find(c => c.id === characterId)
  const jobs = snapshot?.jobs.filter(j => j.characterId === characterId && j.kind === 'generate') ?? []
  const completed = jobs.filter(j => j.stage === 'complete')
  const output = completed.find(j => j.id === jobId)
  const active = snapshot?.jobs.find(j => !done.has(j.stage))
  const activeBatch = snapshot?.batches.find(b => b.status === 'running')
  const locked = busy || !!active || !!activeBatch || !!snapshot?.designer?.designs.some(d => d.status === 'running') || snapshot?.designer?.modelDownload?.status === 'running'
  const blocked = checks.filter(c => c.status === 'blocked')
  const gpu = checks.find(check => check.gpu)?.gpu
  const encoderAdvice = recommendTextEncoder(gpu)
  const animationUrl = animationPart === 'clip' ? output?.clipPreviewUrl : animationPart === 'transition' ? output?.transitionPreviewUrl : output?.previewUrl
  const url = mode === 'animation' ? animationUrl : mode === 'rig' ? character?.rigPreviewUrl : character?.previewUrl

  async function refreshChecks() {
    if (!window.studio) return
    setChecking(true)
    try { setChecks(await window.studio.check()) } catch (e) { setError(explain(e)) } finally { setChecking(false) }
  }
  useEffect(() => {
    if (!window.studio) { setError('The native desktop bridge is unavailable. Start CharacterStudio.exe or run npm run dev.'); return }
    window.studio.snapshot().then(s => {
      setSnapshot(s); setSettings(s.settings)
      if (s.characters.length) selectCharacter(s.characters[0])
    }).catch(e => setError(explain(e)))
    const remove = window.studio.onUpdate(setSnapshot)
    void refreshChecks()
    return remove
  }, [])

  function selectCharacter(c: Character) {
    setCharacterId(c.id); setSetup(structuredClone(c.setup)); setDirty(false)
    setMode(c.rigged ? 'rig' : 'input'); setFit(false); setJobId(''); setParentJobId(''); setAnimationPart('path')
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
  async function createRig() {
    if (!character) return
    await perform(async () => {
      if (dirty) await saveFit()
      await window.studio.rig(character.id)
      setMode('rig'); setFit(false); setNotice('Skin weights validated. Your character is ready for motion instructions.')
    })
  }
  async function generate() {
    if (!character) return
    await perform(async () => {
      await window.studio.generate({ characterId: character.id, prompt, seconds, seed, steps, inPlace, parentJobId: parentJobId || undefined })
      const s = await window.studio.snapshot()
      setSnapshot(s)
      const latest = s.jobs.find(j => j.characterId === character.id && j.kind === 'generate' && j.stage === 'complete')
      if (latest) { setJobId(latest.id); setMode('animation'); setFit(false); setAnimationPart('path') }
    })
  }
  const stages = [
    { label: 'Import character', detail: 'FBX mesh + materials', icon: Box, ready: !!character },
    { label: 'Fit & skin', detail: 'Local humanoid rig', icon: Bone, ready: !!character?.rigged && !dirty },
    { label: 'Generate motion', detail: 'Instructions → animation', icon: Sparkles, ready: completed.length > 0 }
  ]
  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><svg viewBox="-44 -30 152 200" width="26" height="28" fill="none" stroke="currentColor" strokeWidth="8.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={humanOutline} transform="translate(-34 -22)" fill="var(--lime)" strokeOpacity={0.46} /><path d={humanOutline} transform="translate(-17 -11)" fill="var(--lime)" strokeOpacity={0.74} /><path d={humanOutline} fill="var(--lime)" /></svg></span><div className="brand-name"><strong>character<span>studio</span></strong></div></div>
      <nav className="workspace-tabs" role="tablist" aria-label="Character workspace" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'designer' : event.key === 'End' ? 'animator' : workspace === 'designer' ? 'animator' : 'designer'
        setWorkspace(next)
        document.getElementById(`${next}-tab`)?.focus()
      }}>
        <button id="designer-tab" role="tab" tabIndex={workspace === 'designer' ? 0 : -1} aria-selected={workspace === 'designer'} aria-controls="designer-panel" className={workspace === 'designer' ? 'active' : ''} onClick={() => setWorkspace('designer')}>Designer</button>
        <span className="module-divider" aria-hidden="true">|</span>
        <button id="animator-tab" role="tab" tabIndex={workspace === 'animator' ? 0 : -1} aria-selected={workspace === 'animator'} aria-controls="animator-panel" className={workspace === 'animator' ? 'active' : ''} onClick={() => setWorkspace('animator')}>Animator</button>
      </nav>
      <button aria-label="Backend connections" className={`connection ${blocked.length ? 'warning' : ''}`} onClick={() => setSettingsOpen(true)}><span className="tiny-dot" />{checking ? 'Checking backends' : blocked.length ? 'Setup needs attention' : checks.length ? 'Local backends ready' : 'Backend settings'}<Settings2 size={14} /></button>
    </header>
    {snapshot && <DesignerPanel snapshot={snapshot} visible={workspace === 'designer'} animatorBusy={busy || !!active || !!activeBatch} onSettings={() => setSettingsOpen(true)} onAnimate={c => { selectCharacter(c); setFit(true); setWorkspace('animator') }} />}
    <div id="animator-panel" role="tabpanel" aria-labelledby="animator-tab" hidden={workspace !== 'animator'} className="studio-layout">
      <aside className="left-panel">
        <div className="section-kicker">YOUR WORKSPACE</div><h1>Character lab</h1>
        <p className="intro">From static mesh to something<br />with a little more life.</p>
        <button className="import-button" disabled={locked} onClick={importFbx}><Plus size={18} /> Import FBX <span>LOCAL FILE</span></button>
        <button className="text-button full" disabled={locked} onClick={() => void perform(async () => { const characters = await window.studio.importCollection(); if (characters[0]) selectCharacter(characters[0]) })}><FolderOpen size={14} /> Import FBX collection</button>
        <button className="secondary full library-button" onClick={() => { setLibraryNew(false); setLibraryOpen(true) }}><Layers3 size={15} /> Motion library & batches</button>
        <nav className="steps">
          {stages.map((stage, i) => <button key={stage.label} className={`step ${stage.ready ? 'ready' : ''} ${i === 1 && fit ? 'current' : ''}`} disabled={!character || locked} onClick={() => { setMode(i === 2 && output ? 'animation' : i === 1 && character?.rigged ? 'rig' : 'input'); setFit(i === 1); if (i === 1) setMode('input') }}>
            <span className="step-number">{stage.ready ? <CheckIcon size={14} /> : `0${i + 1}`}</span><span><strong>{stage.label}</strong><small>{stage.detail}</small></span><stage.icon size={16} />
          </button>)}
        </nav>
        <div className="panel-rule" />
        <div className="section-heading"><span className="section-kicker">CHARACTERS</span><span className="count">{snapshot?.characters.length ?? 0}</span></div>
        <div className="asset-list">
          {snapshot?.characters.map(c => <button className={`asset ${c.id === characterId ? 'active' : ''}`} key={c.id} disabled={locked} onClick={() => selectCharacter(c)}>
            <span className="asset-icon"><PersonIcon /></span><span><strong>{c.name}</strong><small>{c.rigged ? 'Skinned humanoid' : 'Unrigged import'} · {Math.round(c.vertices / 1000)}k verts</small></span>
          </button>)}
          {!snapshot?.characters.length && <div className="empty-assets"><FolderOpen size={24} /><p>No characters yet</p><small>Your imported files stay on this PC.</small></div>}
        </div>
        {character && <div className="asset-detail"><span>{character.meshes} MESH{character.meshes !== 1 ? 'ES' : ''}</span><span>2m WORKING SCALE</span></div>}
        <div className="local-note"><ShieldCheck size={19} /><div><strong>Made to stay local.</strong><p>Rigging, motion, and character files stay on your machine.</p></div></div>
        <button className="text-button data-button" onClick={() => void perform(() => window.studio.revealData())}><FolderOpen size={14} /> Open workspace files</button>
      </aside>

      <main className="center-panel">
        <div className="scene-heading">
          <div><span className="section-kicker">SCENE</span><h2>{character?.name.replace(/\.fbx$/i, '') ?? 'Untitled character'}<span className="file-tag">{mode === 'animation' ? 'ANIMATED' : character?.rigged && !dirty ? 'RIGGED' : 'FBX'}</span></h2></div>
          <div className="view-tabs">
            <button className={mode === 'input' ? 'active' : ''} disabled={!character || locked} onClick={() => { setMode('input'); setFit(false) }}>Original</button>
            <button className={mode === 'rig' ? 'active' : ''} disabled={!character?.rigged || dirty || locked} onClick={() => { setMode('rig'); setFit(false) }}>Rigged</button>
            <button className={mode === 'animation' ? 'active' : ''} disabled={!output || locked} onClick={() => { setMode('animation'); setFit(false) }}>Animation</button>
          </div>
        </div>
        <Viewport url={url} setup={setup} fit={fit && !locked && !!character} kind={mode} selected={selected} onSelect={setSelected} onMove={move} />
        {(active || activeBatch) && <div className="job-progress" role="status"><LoaderCircle size={17} className="spin" /><div><strong>{activeBatch ? `BATCH · ${activeBatch.items.filter(i => i.status === 'complete').length}/${activeBatch.items.length}` : active!.stage.toUpperCase()}</strong><p>{active?.message ?? 'Checking batch prerequisites'}</p><div className="progress-track"><span style={{ width: `${active?.progress ?? 5}%` }} /></div></div><button onClick={() => void window.studio.cancel().catch(e => setError(explain(e)))}>Cancel</button></div>}
        {error && <div className="banner error" role="alert"><CircleAlert size={18} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div className="banner success" role="status"><CheckIcon size={18} /><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={16} /></button></div>}
        <section className="takes">
          <div className="section-heading"><div><span className="section-kicker">MOTION TAKES</span><span className="count">{jobs.length}</span></div><small>Saved automatically on this PC</small></div>
          {!jobs.length ? <div className="no-takes"><span className="take-placeholder"><Sparkles size={19} /></span><div><strong>A new move starts with a few words.</strong><p>Generated takes will appear here, ready to preview and export.</p></div></div> :
            <div className="take-list">{jobs.map(job => <button key={job.id} disabled={job.stage !== 'complete' || locked} className={`take ${jobId === job.id ? 'selected' : ''} ${job.stage}`} onClick={() => { setJobId(job.id); setMode('animation'); setFit(false); setAnimationPart('path') }}>
              <span className="take-icon">{job.stage === 'complete' ? <Sparkles size={17} /> : job.stage === 'failed' ? <CircleAlert size={17} /> : <LoaderCircle size={17} />}</span><span><strong>{job.label || job.prompt || 'Motion take'}</strong><small>{job.stage === 'complete' ? `${job.parentJobId ? 'Full branch · ' : ''}${job.seconds}s / segment · seed ${job.seed}` : job.stage}</small>{job.stage === 'failed' && <small className="failure-text">{job.message}</small>}</span><span className="take-time">{new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </button>)}</div>}
        </section>
      </main>

      <aside className="right-panel">
        {fit && character ? <>
          <div className="section-kicker">02 / PREPARE CHARACTER</div><h2>Fit the humanoid rig</h2><p className="panel-description">Use a full-body T- or A-pose. Point the character forward (+Z), then place joints inside the mesh.</p>
          <label className="field-label">Orientation <span>degrees</span></label>
          <div className="xyz-fields">{(['X', 'Y', 'Z'] as const).map((axis, i) => <label key={axis}>{axis}<select aria-label={`Rotate ${axis}`} disabled={locked} value={setup.rotation[i]} onChange={e => { const rotation = [...setup.rotation] as Vec3; rotation[i] = Number(e.target.value); setSetup({ ...setup, rotation }); setDirty(true) }}>{[-180, -90, 0, 90, 180].map(v => <option key={v} value={v}>{v}°</option>)}</select></label>)}</div>
          <label className="field-label" htmlFor="joint-select">Selected landmark</label>
          <select id="joint-select" value={selected} onChange={e => setSelected(e.target.value)}>{Object.keys(setup.landmarks).map(name => <option key={name}>{name}</option>)}</select>
          <div className="xyz-fields positions">{(['X', 'Y', 'Z'] as const).map((axis, i) => <label key={axis}>{axis}<input aria-label={`Joint ${axis}`} type="number" step="0.01" min="-4" max="4" value={Number(setup.landmarks[selected][i].toFixed(3))} disabled={locked} onChange={e => { const point = [...setup.landmarks[selected]] as Vec3; point[i] = Number(e.target.value); move(selected, point) }} /></label>)}</div>
          <label className="checkbox"><input type="checkbox" checked={mirror} onChange={e => setMirror(e.target.checked)} /> Mirror left / right joints</label>
          <div className="fit-instructions"><strong>Fit in two views</strong><p>Front: hips, knees, shoulders, elbows.<br />Side: joint depth, spine, toes.<br />White joint = selected. Drag its axis handles.</p></div>
          <button className="secondary full" disabled={locked} onClick={() => { setSetup({ ...setup, landmarks: defaultLandmarks() }); setDirty(true) }}><RotateIcon /> Reset landmark template</button>
          {dirty && <button className="text-button full" disabled={locked} onClick={() => void perform(async () => { await saveFit(); setNotice('Fit saved. Rebuild the rig to apply these changes.') })}><CheckIcon size={14} /> Save fit without rigging</button>}
          <button className="primary full" disabled={locked} onClick={createRig}><Bone size={17} /> {character.rigged && !dirty ? 'Rebuild skin + rig' : 'Build skin + rig'}<ArrowRight size={17} /></button>
          <p className="fine-print">Real Blender bone-heat weights, not a skeleton overlay. Body rig only; fingers and face are not auto-rigged.</p>
        </> : <>
          <div className="section-kicker">03 / DIRECT THE MOTION</div><h2>What’s the move?</h2><p className="panel-description">Describe a movement. Kimodo generates the motion; Blender applies it to your character.</p>
          <label htmlFor="motion-prompt" className="field-label">Motion instructions <Sparkles size={13} /></label>
          <div className="prompt-field"><textarea id="motion-prompt" value={prompt} disabled={locked} maxLength={1000} onChange={e => setPrompt(e.target.value)} placeholder="A person waves with their right hand…" /><span>{prompt.length} / 1000</span></div>
          <div className="prompt-suggestions">{['Walk forward', 'Wave hello', 'Look around'].map((text, i) => <button disabled={locked} key={text} onClick={() => setPrompt(['A person walks forward at a relaxed pace.', 'A person stands and waves hello with their right hand.', 'A person stands and slowly looks around.'][i])}>{text}</button>)}</div>
          <button className="text-button full" disabled={locked} onClick={() => { setLibraryNew(true); setLibraryOpen(true) }}><Layers3 size={14} /> Save this configuration</button>
          {completed.length > 0 && <><label className="field-label" htmlFor="branch-parent">Start from an existing take</label><select id="branch-parent" disabled={locked} value={parentJobId} onChange={e => { setParentJobId(e.target.value); const parent = completed.find(j => j.id === e.target.value); if (parent) setInPlace(parent.inPlace ?? false) }}><option value="">New independent motion</option>{completed.map(j => <option value={j.id} key={j.id}>{j.label || j.prompt}</option>)}</select>{parentJobId && <p className="fine-print">Conditioned on the parent's final full-body pose. Export includes the parent and new motion as one branch.</p>}</>}
          <div className="panel-rule" />
          <div className="two-fields"><label>Duration / segment<div className="unit-input"><input aria-label="Duration seconds" disabled={locked} type="number" min="0.5" max="30" step="0.5" value={seconds} onChange={e => setSeconds(Number(e.target.value))} /><span>sec</span></div></label><label>Seed<input aria-label="Motion seed" disabled={locked} type="number" min="0" max="4294967295" value={seed} onChange={e => setSeed(Number(e.target.value))} /></label></div>
          <label className="field-label" htmlFor="steps">Denoising steps <span>quality</span></label><select id="steps" disabled={locked} value={steps} onChange={e => setSteps(Number(e.target.value))}><option value="25">25 — quick draft</option><option value="50">50 — balanced</option><option value="100">100 — standard</option><option value="200">200 — detailed</option></select>
          <label className="checkbox"><input disabled={locked || !!parentJobId} type="checkbox" checked={inPlace} onChange={e => setInPlace(e.target.checked)} /> Keep root in place</label>
          <p className="fine-print">Periods create separate motion segments. Playback loops the clip; seamless looping is not guaranteed.</p>
          {!character?.rigged || dirty ? <button className="primary full" disabled={!character || locked} onClick={() => { setFit(true); setMode('input') }}><SlidersHorizontal size={17} /> Fit character first<ArrowRight size={17} /></button> : <button className="primary full" disabled={locked || prompt.trim().length < 3} onClick={generate}><WandSparkles size={17} /> Generate animation<ArrowRight size={17} /></button>}
          {character?.rigged && !dirty && <button className="text-button full" disabled={locked} onClick={() => { setFit(true); setMode('input') }}><Bone size={14} /> Adjust rig fit</button>}
          {!!blocked.length && <button className="setup-warning" onClick={() => setSettingsOpen(true)}><CircleAlert size={16} /><span>{blocked.some(c => c.name.includes('text encoder')) ? 'Set up the local text encoder' : `${blocked.length} backend check${blocked.length > 1 ? 's' : ''} need attention`}<small>Review setup before generation <ArrowRight size={11} /></small></span></button>}
        </>}
        {!!character?.warnings.length && <details className="warnings"><summary>Import notes <ChevronDown size={13} /></summary>{character.warnings.map(w => <p key={w}>{w}</p>)}</details>}
        <div className="output-section">
          <div className="section-kicker">EXPORT CHARACTER</div>
          {output ? <><h3>Ready for your next scene.</h3>
            {output.clipPreviewUrl && <><label className="field-label" htmlFor="preview-part">Preview output</label><select id="preview-part" value={animationPart} onChange={e => { setAnimationPart(e.target.value as typeof animationPart); setMode('animation') }}><option value="path">Full path</option><option value="clip">Node clip</option>{output.transitionPreviewUrl && <option value="transition">Incoming transition</option>}</select><p className="fine-print">{output.graphContext?.pathLabel}</p></>}
            <button className="text-button full" disabled={locked} onClick={() => { setParentJobId(output.id); setInPlace(output.inPlace ?? false); setNotice('Next generation will branch from this take’s final pose.') }}>Branch from this take <ArrowRight size={13} /></button>{output.outputFiles?.map(file => <button key={file} className="download" onClick={() => void perform(async () => { const path = await window.studio.saveOutput(output.id, file); if (path) setNotice(`Saved ${path}`) })}><ArrowDownToLine size={16} /><span>{outputLabel(file)}</span></button>)}{output.warnings?.map(w => <p className="fine-print" key={w}>{w}</p>)}</> : <><div className="export-disabled"><ArrowDownToLine size={18} /><span>Animated GLB + FBX</span></div><p className="fine-print">Available after a completed, validated character animation. A skeleton alone is not an animated character.</p></>}
        </div>
      </aside>
    </div>
    <footer><span><ShieldCheck size={12} /> LOCAL PIPELINE</span><span>{workspace === 'designer' ? <>Character & scene <ArrowRight size={10} /> T-pose reference <ArrowRight size={10} /> 3D geometry <ArrowRight size={10} /> Animator</> : <>FBX import <ArrowRight size={10} /> Blender rig + skin <ArrowRight size={10} /> ComfyUI / Kimodo <ArrowRight size={10} /> Character export</>}</span><span>ARM64 READY</span></footer>
    {libraryOpen && snapshot && <LibraryPanel snapshot={snapshot} setup={setup} current={{ prompt, seconds, seed, steps, inPlace }} characterId={characterId} startNew={libraryNew} onClose={() => setLibraryOpen(false)} onApply={(node, savedFit) => {
      setPrompt(node.prompt); setSeconds(node.seconds); setSeed(node.seed); setSteps(node.steps); setInPlace(node.inPlace); setParentJobId('')
      if (savedFit && character) { setSetup({ ...structuredClone(savedFit), rotation: setup.rotation }); setDirty(true); setFit(true); setMode('input') }
      setNotice('Prompt settings applied independently. Generate the saved graph to preserve incoming pose context, transitions and loop constraints.')
    }} onPreview={(id, job, part = 'path') => { const c = snapshot.characters.find(c => c.id === id); if (c) { selectCharacter(c); setJobId(job); setAnimationPart(part); setMode('animation') } }} />}

    {settingsOpen && settings && <div className="modal-backdrop"><section className="settings-modal" role="dialog" aria-modal="true" aria-label="Local backend settings">
      <div className="modal-heading"><div><span className="section-kicker">LOCAL INFRASTRUCTURE</span><h2>Backend connections</h2></div><button aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={20} /></button></div>
      <p className="panel-description">Blender runs independently on CPU. The existing ComfyUI GPU environment is reused, never reinstalled or downgraded.</p>
      <label className="field-label" htmlFor="text-encoder">Kimodo text encoder</label>
      <select id="text-encoder" aria-describedby="encoder-memory-guidance" disabled={locked || starting} value={settings.textEncoder ?? 'llm2vec'} onChange={e => setSettings({ ...settings, textEncoder: e.target.value === 'lfm' ? 'lfm' : 'llm2vec' })}>
        <option value="llm2vec">Llama + LLM2Vec (original, ~16 GB weights){encoderAdvice.encoder === 'llm2vec' ? ' - Recommended for available memory' : ''}</option>
        <option value="lfm">LFM bridge (experimental, ~0.7 GB weights, no approval){encoderAdvice.encoder === 'lfm' ? ' - Recommended for available memory' : ''}</option>
      </select>
      <div id="encoder-memory-guidance" className="fine-print" aria-live="polite">
        {gpu && <p aria-label="Detected GPU memory"><strong>{gpu.name}</strong>: {gpu.freeGB.toFixed(1)} GiB free / {gpu.totalGB.toFixed(1)} GiB total GPU memory.</p>}
        <p>{encoderAdvice.detail}</p>
        <p>The 24 GiB recommendation is a conservative estimate, not a tested minimum or a guarantee of fit.
          Weight sizes are downloads, not peak usage; LFM runs in float32. Kimodo, motion duration, other models and existing allocations also use memory.
          Shared/unified GPU memory may differ from dedicated VRAM. Your saved selection is never changed automatically.</p>
      </div>
      <ModelSetupGuide comfyRoot={snapshot?.settings.comfyRoot ?? settings.comfyRoot} textEncoder={settings.textEncoder ?? 'llm2vec'} needsSetup={blocked.some(c => c.name.includes('text encoder') || (settings.textEncoder === 'lfm' && c.detail.includes('Studio_Kimodo_LoadLFM')))} checking={checking}
        onAccessPage={() => void perform(() => window.studio.openAccessPage())}
        onTokenSettings={() => void perform(() => window.studio.openTokenSettings())}
        onRefresh={() => void refreshChecks()} />
      <label className="field-label" htmlFor="comfy-url">ComfyUI API URL <span>loopback only</span></label><input id="comfy-url" value={settings.comfyUrl} onChange={e => setSettings({ ...settings, comfyUrl: e.target.value })} />
      {([['blenderPath', 'Blender executable', 'blender'], ['comfyRoot', 'ComfyUI backend folder', 'comfy'], ['comfyOutput', 'ComfyUI output folder', 'output']] as const).map(([key, label, kind]) => <div key={key}><label className="field-label" htmlFor={key}>{label}</label><div className="path-field"><input id={key} value={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.value })} /><button aria-label={`Browse ${label}`} onClick={() => void perform(async () => { const path = await window.studio.browse(kind); if (path) setSettings(old => old ? { ...old, [key]: path, ...(key === 'comfyRoot' ? { comfyOutput: path + '\\output' } : {}) } : old) })}><FolderOpen size={17} /></button></div></div>)}
      <div className="settings-actions"><button className="secondary" disabled={locked || starting} onClick={() => void perform(async () => { await window.studio.settings(settings); setNotice('Backend settings saved.'); await refreshChecks() })}><CheckIcon size={15} /> Save settings</button>
      <button className="primary" disabled={starting || locked} onClick={async () => { setStarting(true); setError(''); try { await window.studio.settings(settings); await window.studio.startComfy(); await refreshChecks() } catch (e) { setError(explain(e)) } finally { setStarting(false) } }}>{starting ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}{starting ? 'Starting ComfyUI…' : 'Start local ComfyUI'}</button></div>
      <div className="section-heading"><span className="section-kicker">READINESS CHECKS</span><button className="text-button" disabled={checking} onClick={refreshChecks}><RefreshCw size={13} className={checking ? 'spin' : ''} /> Refresh</button></div>
      <div className="checks">{checks.map(check => <div className={`check ${check.status}`} key={check.name}>{check.status === 'ready' ? <CheckIcon size={16} /> : <CircleAlert size={16} />}<div><strong>{check.name}</strong><p>{check.detail}</p></div></div>)}</div>
      {error && <p className="modal-error" role="alert">{error}</p>}
      <p className="fine-print">Both encoders run locally inside ComfyUI. LFM uses an explicit experimental Kimodo loader; it never falls back to Llama or remote inference. The original Llama loader uses TEXT_ENCODER_MODE=local when Studio starts ComfyUI; use that setting for an externally started backend. Hugging Face supplies downloads only. Closing Studio stops only the ComfyUI process it started.</p>
    </section></div>}
  </div>
}

function PersonIcon() { return <Box size={21} strokeWidth={1.3} /> }
function RotateIcon() { return <RefreshCw size={14} /> }
function outputLabel(file: string) {
  const [name, extension] = file.split('.')
  const label = name === 'animated' ? 'Full character path' : name === 'clip' ? 'Character node clip' : name === 'transition' ? 'Incoming transition' : name === 'sequence' ? 'Full path motion only' : 'Node motion only'
  return `${label} · ${extension === 'blend' ? 'Blender' : extension.toUpperCase()}`
}
