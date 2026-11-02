import { useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Check, Copy, FolderOpen, GitBranch, Layers3, Plus, Save, X, RefreshCw } from 'lucide-react'
import type { GenerateRequest, MotionNode, MotionPlan, RigSetup, Snapshot } from '../shared/types'
import { expandGraph } from '../shared/plans'
import { MotionGraph } from './MotionGraph'
import { AiRouteBadge } from './AiProvidersPanel'
import { aiRouteLabel } from '../shared/ai'

interface Props {
  snapshot: Snapshot
  current: Pick<GenerateRequest, 'prompt' | 'seconds' | 'seed' | 'steps' | 'inPlace'>
  setup: RigSetup
  characterId: string
  startNew: boolean
  onClose(): void
  onApply(node: MotionNode, setup?: RigSetup): void
  onPreview(characterId: string, jobId: string, part?: 'path' | 'clip' | 'transition'): void
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')

export function LibraryPanel(props: Props) {
  const newNode = (label: string, kind: MotionNode['kind'] = 'action'): MotionNode => ({
    id: crypto.randomUUID(), label, ...props.current, kind, loop: kind === 'state', stance: '', position: { x: 0, y: 0 }
  })
  const newPlan = (): MotionPlan => {
    const node = newNode('Motion')
    return { id: crypto.randomUUID(), name: 'My animation graph', rigSetup: structuredClone(props.setup), nodes: [node], graphVersion: 2, edges: [], entryNodeIds: [node.id] }
  }
  const [plan, setPlan] = useState(() => !props.startNew && props.snapshot.plans[0] ? structuredClone(props.snapshot.plans[0]) : newPlan())
  const [selectedId, setSelectedId] = useState(plan.nodes[0].id)
  const [edgeId, setEdgeId] = useState('')
  const [contextKey, setContextKey] = useState('')
  const [connectTarget, setConnectTarget] = useState('')
  const [selectedCharacters, setSelectedCharacters] = useState<string[]>(props.characterId ? [props.characterId] : [])
  const [stride, setStride] = useState(0)
  const [autoRig, setAutoRig] = useState(false)
  const [applyFit, setApplyFit] = useState(false)
  const [dirty, setDirty] = useState(props.startNew || !props.snapshot.plans.length)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const [tab, setTab] = useState<'plans' | 'batches'>('plans')
  const selected = plan.nodes.find(n => n.id === selectedId) ?? plan.nodes[0]
  const selectedEdge = plan.edges.find(e => e.id === edgeId)
  const running = props.snapshot.batches.find(b => b.status === 'running')
  const locked = working || !!running || props.snapshot.jobs.some(j => !['complete', 'failed', 'cancelled'].includes(j.stage)) || props.snapshot.designer?.modelDownload?.status === 'running'
  const expansion = useMemo(() => {
    try { return { contexts: expandGraph(plan), error: '' } }
    catch (e) { return { contexts: [], error: message(e) } }
  }, [plan])
  const nodeContexts = expansion.contexts.filter(c => c.path.at(-1) === selected.id)
  const context = nodeContexts.find(c => c.key === contextKey) ?? nodeContexts[0]
  const activeCharacter = props.snapshot.characters.find(c => c.id === props.characterId)
  const contextResults = context ? props.snapshot.jobs.filter(j => j.stage === 'complete' && j.characterId === props.characterId && j.graphContext?.key === context.key) : []

  function change(value: MotionPlan) { setPlan(value); setDirty(true) }
  function choose(value: MotionPlan, unsaved = false) {
    setPlan(structuredClone(value)); setSelectedId(value.nodes[0].id); setEdgeId(''); setContextKey(''); setDirty(unsaved); setError(''); setNotice('')
  }
  function updateNode(value: Partial<MotionNode>) {
    const connected = new Set([selected.id])
    if (value.inPlace !== undefined) {
      for (let i = 0; i < plan.nodes.length; i++) for (const edge of plan.edges) {
        if (connected.has(edge.source) || connected.has(edge.target)) { connected.add(edge.source); connected.add(edge.target) }
      }
    }
    change({ ...plan, nodes: plan.nodes.map(n => ({
      ...n, ...(value.inPlace !== undefined && connected.has(n.id) ? { inPlace: value.inPlace } : {}),
      ...(n.id === selected.id ? value : {})
    })) })
  }
  async function action(fn: () => Promise<void>) {
    setWorking(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(message(e)) } finally { setWorking(false) }
  }
  async function save() {
    const saved = await window.studio.savePlan(plan)
    setPlan(saved); setDirty(false); return saved
  }
  function add(kind: MotionNode['kind']) {
    const node = {
      ...newNode(kind === 'state' ? 'New state' : 'New action', kind),
      prompt: kind === 'state' ? 'A person stands relaxed with subtle natural motion.' : 'A person throws a right hook punch.',
      position: { x: selected.position.x + 320, y: selected.position.y + 170 }, inPlace: selected.inPlace
    }
    change({ ...plan, nodes: [...plan.nodes, node], edges: [...plan.edges, { id: crypto.randomUUID(), source: selected.id, target: node.id, seconds: 0.5 }] })
    setSelectedId(node.id); setEdgeId('')
  }
  function fightingTemplate() {
    const idle = { ...newNode('Fighting idle', 'state'), prompt: 'Idle in a fighting position, subtle slight swaying motion, ready for action.', stance: 'Standing upright in a fighting stance', seconds: 3, inPlace: true }
    const crouch = { ...newNode('Low crouch', 'state'), prompt: 'Crouched down low in a fighting position, with slight subtle motion.', stance: 'Crouched down low in a fighting stance', position: { x: 320, y: 210 }, seconds: 3, seed: 43, inPlace: true }
    const punch = { ...newNode('Right hook'), prompt: 'Throw a right hook punch.', position: { x: 640, y: 0 }, seconds: 2, seed: 44, inPlace: true }
    choose({
      ...newPlan(), name: 'Fighting state graph', nodes: [idle, crouch, punch], entryNodeIds: [idle.id],
      edges: [[idle.id, punch.id], [idle.id, crouch.id], [crouch.id, punch.id]].map(([source, target]) => ({ id: crypto.randomUUID(), source, target, seconds: 0.5 }))
    }, true)
  }
  function crouchTemplate() {
    const crouch = { ...newNode('Crouch', 'state'), prompt: 'A person holds a low crouch with subtle motion.', seconds: 3 }
    const jump = { ...newNode('Jump'), prompt: 'Jump upward and land.', position: { x: 320, y: -100 }, seconds: 3, seed: 43 }
    const lie = { ...newNode('Lie down'), prompt: 'Lower to the ground and lie down.', position: { x: 320, y: 130 }, seconds: 4, seed: 44 }
    choose({ ...newPlan(), name: 'Crouch branches', nodes: [crouch, jump, lie], entryNodeIds: [crouch.id],
      edges: [jump, lie].map(n => ({ id: crypto.randomUUID(), source: crouch.id, target: n.id, seconds: 0.5 })) }, true)
  }
  function connect() {
    if (!connectTarget) return
    if (plan.edges.some(e => e.source === selected.id && e.target === connectTarget)) { setError('These nodes are already connected.'); return }
    change({ ...plan, edges: [...plan.edges, { id: crypto.randomUUID(), source: selected.id, target: connectTarget, seconds: 0.5 }] })
    setConnectTarget(''); setError('')
  }
  async function queue() {
    await action(async () => {
      const saved = await save(); setTab('batches')
      await window.studio.runBatch({ planId: saved.id, characterIds: selectedCharacters, seedStride: stride, autoRig })
    })
  }

  return <div className="modal-backdrop">
    <section className="library-modal graph-library" role="dialog" aria-modal="true" aria-label="Motion library and batches">
      <div className="modal-heading"><div><span className="section-kicker">STATE / ACTION / CONTEXT</span><h2>Animation graph</h2></div>
        <div className="library-top-actions"><div className="view-tabs"><button className={tab === 'plans' ? 'active' : ''} onClick={() => setTab('plans')}>Graph editor</button><button className={tab === 'batches' ? 'active' : ''} onClick={() => setTab('batches')}>Generated paths <span className="count">{props.snapshot.batches.length}</span></button></div><button aria-label="Close motion library" onClick={props.onClose}><X size={20} /></button></div>
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {notice && <div className="banner success" role="status">{notice}</div>}
      {tab === 'plans' ? <div className="library-grid">
        <aside className="preset-list" aria-label="Saved animation graphs">
          <button className="secondary full" disabled={locked} onClick={() => choose(newPlan(), true)}><Plus size={15} /> New graph</button>
          {props.snapshot.plans.map(p => <button className={`preset ${p.id === plan.id ? 'active' : ''}`} key={p.id} disabled={locked} onClick={() => choose(p)}><Layers3 size={16} /><span><strong>{p.name}</strong><small>{p.nodes.length} nodes · {p.edges.length} connections</small></span></button>)}
          <button className="text-button full" disabled={locked} onClick={fightingTemplate}><GitBranch size={14} /> Fighting graph template</button>
          <button className="text-button full" disabled={locked} onClick={crouchTemplate}>Crouch branching template</button>
          <div className="panel-rule" />
          <button className="text-button full" disabled={locked} onClick={() => void action(async () => { const p = await window.studio.importPlan(); if (p) choose(p) })}><FolderOpen size={14} /> Import configuration JSON</button>
          <button className="text-button full" disabled={locked || !!expansion.error} onClick={() => void action(async () => { await save(); const path = await window.studio.exportPlan(plan.id); if (path) setNotice(`Configuration saved to ${path}`) })}><ArrowDownToLine size={14} /> Export configuration JSON</button>
          <p className="fine-print">Save the layout, shared actions, entry states, transitions, prompts, seeds and rig fit as one reusable graph. Older branch configurations are preserved as direct pose joins.</p>
        </aside>
        <div className="plan-editor" aria-label="Animation graph editor">
          <label className="field-label" htmlFor="plan-name">Graph name {dirty && <span>UNSAVED</span>}</label>
          <input id="plan-name" value={plan.name} disabled={locked} onChange={e => change({ ...plan, name: e.target.value })} />
          <div className="node-actions"><button className="secondary" disabled={locked || plan.nodes.length >= 32 || plan.edges.length >= 64} onClick={() => add('state')}><Plus size={13} /> Add state</button><button className="secondary" disabled={locked || plan.nodes.length >= 32 || plan.edges.length >= 64} onClick={() => add('action')}><Plus size={13} /> Add action</button><span className="fine-print">{expansion.contexts.length} path-specific clips / character</span></div>
          <MotionGraph key={plan.id} plan={plan} contexts={expansion.contexts} selectedId={selected.id} edgeId={edgeId} locked={locked} onChange={change}
            onNode={id => { setSelectedId(id); setEdgeId(''); setContextKey('') }} onEdge={setEdgeId} onError={setError} />
          <p className="fine-print">Drag nodes to arrange. Drag an output dot to an input dot to connect. One action can have many incoming paths. Scroll to zoom; drag the background to pan.</p>
          {expansion.error && <div className="banner error" role="alert">{expansion.error}</div>}
          <div className="node-actions"><button className="primary" disabled={locked || !!expansion.error} onClick={() => void action(async () => { await save(); setNotice('Graph saved with exact seeds, layout and context relationships.') })}><Save size={15} /> Save graph</button><button className="secondary" disabled={locked} onClick={() => choose({ ...plan, id: crypto.randomUUID(), name: plan.name + ' copy' }, true)}><Copy size={14} /> Duplicate graph</button></div>
          <section className="context-inspector">
            <label className="field-label" htmlFor="incoming-context">Incoming context for {selected.label}</label>
            <select id="incoming-context" value={context?.key ?? ''} onChange={e => setContextKey(e.target.value)}>
              {nodeContexts.map(c => <option value={c.key} key={c.key}>{c.pathLabel}{c.cycleEnd ? ' (cycle stop)' : ''}</option>)}
            </select>
            {context && <>
              <p><strong>Entry pose:</strong> {context.parentKey ? 'The actual previous clip endpoint on this path' : 'Generated starting state'}.</p>
              <p><strong>Inherited stance:</strong> {context.inheritedStance || 'None; this is a starting node'}.</p>
              <p><strong>Outgoing stance:</strong> {context.resultingStance || 'Use the actual generated ending pose'}.</p>
              <details><summary>Effective model instructions</summary><p className="effective-prompt">{context.effectivePrompt}</p></details>
              <p className="fine-print">The pose is supplied, not guessed from the node label. Explicit action instructions can change stance; use the optional outgoing stance to clarify that change for later actions. Review generated motion: inherited posture is guidance, not a semantic guarantee.</p>
              {contextResults.length > 0 && <div className="context-results"><strong>Saved results for {activeCharacter?.name}</strong>{contextResults.slice(0, 5).map(j => <div key={j.id}><small>{new Date(j.createdAt).toLocaleString()} · seed {j.seed}</small><div className="node-actions">
                {j.clipPreviewUrl && <button className="secondary" onClick={() => { props.onPreview(j.characterId, j.id, 'clip'); props.onClose() }}>Node clip</button>}
                {j.transitionPreviewUrl && <button className="secondary" onClick={() => { props.onPreview(j.characterId, j.id, 'transition'); props.onClose() }}>Transition</button>}
                <button className="secondary" onClick={() => { props.onPreview(j.characterId, j.id, 'path'); props.onClose() }}>Full path</button>
              </div></div>)}</div>}
            </>}
          </section>
        </div>
        <aside className="graph-inspector" aria-label="Animation graph inspector">
          {selectedEdge ? <>
            <div className="section-kicker">CONNECTION</div><h3>{plan.nodes.find(n => n.id === selectedEdge.source)?.label} → {plan.nodes.find(n => n.id === selectedEdge.target)?.label}</h3>
            <label className="field-label" htmlFor="transition-duration">Transition seconds</label><input id="transition-duration" type="number" min="0" max="5" step="0.5" value={selectedEdge.seconds} disabled={locked} onChange={e => change({ ...plan, edges: plan.edges.map(edge => edge.id === edgeId ? { ...edge, seconds: Number(e.target.value) } : edge) })} />
            <p className="fine-print">A generated transition is constrained at both endpoints. Zero skips the transition and requires a direct pose match. Transitions, node clips and full paths are exported separately.</p>
            <button className="text-button full" disabled={locked} onClick={() => { change({ ...plan, edges: plan.edges.filter(e => e.id !== edgeId) }); setEdgeId('') }}>Remove connection</button>
          </> : <>
            <div className="section-kicker">SELECTED NODE</div>
            <label className="field-label" htmlFor="node-name">Name</label><input id="node-name" aria-label="Motion node name" value={selected.label} disabled={locked} onChange={e => updateNode({ label: e.target.value })} />
            <label className="field-label" htmlFor="node-kind">Node type</label><select id="node-kind" value={selected.kind} disabled={locked} onChange={e => updateNode({ kind: e.target.value as MotionNode['kind'], loop: false, legacySegments: false })}><option value="state">State / sustained motion</option><option value="action">Action / one-shot</option></select>
            <label className="checkbox"><input type="checkbox" disabled={locked} checked={plan.entryNodeIds.includes(selected.id)} onChange={e => change({ ...plan, entryNodeIds: e.target.checked ? [...plan.entryNodeIds, selected.id] : plan.entryNodeIds.filter(id => id !== selected.id) })} /> Start graph here</label>
            <label className="field-label" htmlFor="node-prompt">Motion instructions</label><textarea id="node-prompt" rows={3} disabled={locked} value={selected.prompt} onChange={e => updateNode({ prompt: e.target.value })} />
            <label className="field-label" htmlFor="node-stance">Outgoing stance <span>optional override</span></label><textarea id="node-stance" rows={2} placeholder="Leave blank to inherit previous stance" disabled={locked} value={selected.stance} onChange={e => updateNode({ stance: e.target.value })} />
            <div className="three-fields"><label>Seconds<input aria-label="Node duration" type="number" min="0.5" max="30" step="0.5" value={selected.seconds} disabled={locked} onChange={e => updateNode({ seconds: Number(e.target.value) })} /></label><label>Seed<input aria-label="Node seed" type="number" min="0" max="4294967295" value={selected.seed} disabled={locked} onChange={e => updateNode({ seed: Number(e.target.value) })} /></label><label>Steps<input aria-label="Node steps" type="number" min="10" max="500" value={selected.steps} disabled={locked} onChange={e => updateNode({ steps: Number(e.target.value) })} /></label></div>
            <label className="checkbox"><input type="checkbox" disabled={locked || selected.kind !== 'state' || selected.legacySegments} checked={selected.loop} onChange={e => updateNode({ loop: e.target.checked })} /> Constrain state loop endpoints</label>
            <label className="checkbox"><input type="checkbox" disabled={locked} checked={selected.inPlace} onChange={e => updateNode({ inPlace: e.target.checked })} /> In-place root motion</label>
            <p className="fine-print">Root mode applies to the connected graph. State loops use a second constrained generation pass; endpoint poses are checked, but velocity continuity needs review.</p>
            {selected.legacySegments && <p className="fine-print">Legacy clip: periods still create segments. Select a node type to opt into single-clip graph instructions.</p>}
            <label className="field-label" htmlFor="connect-target">Connect to existing node</label><select id="connect-target" value={connectTarget} disabled={locked} onChange={e => setConnectTarget(e.target.value)}><option value="">Choose a destination</option>{plan.nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select>
            <button className="secondary full" disabled={locked || !connectTarget || plan.edges.length >= 64} onClick={connect}>Add connection <ArrowRight size={13} /></button>
            <button className="text-button full" disabled={locked || plan.nodes.length <= 1} onClick={() => {
              const nodes = plan.nodes.filter(n => n.id !== selected.id)
              change({ ...plan, nodes, edges: plan.edges.filter(e => e.source !== selected.id && e.target !== selected.id), entryNodeIds: plan.entryNodeIds.filter(id => id !== selected.id) }); setSelectedId(nodes[0].id)
            }}>Remove node and its connections</button>
            <label className="checkbox"><input type="checkbox" checked={applyFit} onChange={e => setApplyFit(e.target.checked)} /> Also apply saved rig landmarks</label>
            <button className="text-button full" disabled={locked} onClick={() => { props.onApply(selected, applyFit ? plan.rigSetup : undefined); props.onClose() }}>Use prompt in character lab <ArrowRight size={13} /></button>
          </>}
          <div className="panel-rule" />
          <details className="graph-targets" open><summary>Generate for characters</summary>
            <AiRouteBadge snapshot={props.snapshot} stage="motion" />
            <div className="section-heading"><span className="fine-print">TARGETS</span><button className="text-button" disabled={locked} onClick={() => setSelectedCharacters(props.snapshot.characters.slice(0, 32).map(c => c.id))}>Select all</button></div>
            <div className="batch-targets">{props.snapshot.characters.map(c => <label className="checkbox" key={c.id}><input type="checkbox" disabled={locked} checked={selectedCharacters.includes(c.id)} onChange={e => setSelectedCharacters(old => e.target.checked ? [...old, c.id] : old.filter(id => id !== c.id))} /><span>{c.name}<small>{c.rigged ? 'Rig ready' : 'Needs rigging'}</small></span></label>)}{!props.snapshot.characters.length && <p className="fine-print">Import an FBX first.</p>}</div>
            <label className="field-label" htmlFor="seed-stride">Variation per character</label><select id="seed-stride" disabled={locked} value={stride} onChange={e => setStride(Number(e.target.value))}><option value="0">Reuse identical motion per path</option><option value="1">Vary seeds by 1</option><option value="100">Vary seeds by 100</option><option value="1000">Vary seeds by 1000</option></select>
            <label className="checkbox"><input type="checkbox" disabled={locked} checked={autoRig} onChange={e => setAutoRig(e.target.checked)} /> Rig unrigged FBXs using saved fit</label>
            <p className="fine-print">Saved fits assume similar proportions; review skinning. Reuse never mixes standing and crouched paths. Seed offsets vary the performance, not motion intensity.</p>
            <button className="primary full" disabled={locked || !!expansion.error || !selectedCharacters.length || selectedCharacters.length > 32} onClick={queue}><Layers3 size={15} /> Generate graph · {selectedCharacters.length * expansion.contexts.length} variants</button>
            <p className="fine-print">Sequential queue. Up to 64 contexts per character and 60 seconds per path. Cycles stop at the first revisited node; they do not enqueue indefinitely.</p>
          </details>
        </aside>
      </div> : <div className="batch-history">
        {!props.snapshot.batches.length && <div className="empty-assets"><Layers3 size={30} /><p>No generated paths yet</p></div>}
        {props.snapshot.batches.map(batch => <section className="batch-card" key={batch.id}>
          <p className="fine-print">Saved provider: {aiRouteLabel({ version: 1, stages: { motion: batch.aiRoute } }, 'motion')}. Reruns require the same provider, model and workflow.</p>
          <div className="section-heading"><div><h3>{batch.name} <span className={`batch-status ${batch.status}`}>{batch.status}</span></h3><p className="fine-print">{new Date(batch.createdAt).toLocaleString()} · {batch.items.filter(i => i.status === 'complete').length}/{batch.items.length} variants · seed stride {batch.request.seedStride}</p></div><div className="node-actions">
            {batch.status === 'running' ? <button className="secondary" onClick={() => void window.studio.cancel().catch(e => setError(message(e)))}>Cancel batch</button> : <button className="secondary" disabled={locked} onClick={() => void action(() => window.studio.rerunBatch(batch.id))}><RefreshCw size={13} /> Run same batch again</button>}
            <button className="secondary" disabled={!batch.items.some(i => i.status === 'complete')} onClick={() => void action(async () => { const path = await window.studio.exportBatch(batch.id); if (path) setNotice(`Completed batch outputs saved to ${path}`) })}><ArrowDownToLine size={14} /> Save outputs</button>
          </div></div>
          <div className="batch-items">{batch.items.map(item => {
            const job = props.snapshot.jobs.find(j => j.id === item.jobId)
            return <div key={item.id} className={`batch-item ${item.status}`}><span>{item.status === 'complete' ? <Check size={14} /> : <span className="tiny-dot" />}</span><div><strong>{item.characterName} <span>→</span> {item.context?.pathLabel ?? item.label}</strong><small>{item.status} · seed {item.seed}{item.message ? ` · ${item.message}` : ''}</small>{item.context?.inheritedStance && <small>Entry context: {item.context.inheritedStance}</small>}</div>
              {item.status === 'complete' && job && <div className="node-actions">{job.clipPreviewUrl && <button className="text-button" onClick={() => { props.onPreview(item.characterId, job.id, 'clip'); props.onClose() }}>Node clip</button>}{job.transitionPreviewUrl && <button className="text-button" onClick={() => { props.onPreview(item.characterId, job.id, 'transition'); props.onClose() }}>Transition</button>}<button className="text-button" onClick={() => { props.onPreview(item.characterId, job.id, 'path'); props.onClose() }}>Full path</button></div>}
            </div>
          })}</div>
        </section>)}
      </div>}
    </section>
  </div>
}
