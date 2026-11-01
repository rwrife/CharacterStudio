import { useMemo } from 'react'
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, type Node, type NodeProps, type Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { MotionPlan, MotionNode, GraphContext } from '../shared/types'

type GraphNode = Node<{ motion: MotionNode; entry: boolean; variants: number }, 'motion'>
function MotionCard({ data }: NodeProps<GraphNode>) {
  return <div className={`graph-card ${data.motion.kind}`}>
    <Handle type="target" position={Position.Left} id="in" aria-label={`Input for ${data.motion.label}`} />
    <div className="graph-card-tags"><span>{data.motion.kind === 'state' ? 'STATE' : 'ACTION'}</span>{data.entry && <b>START</b>}</div>
    <strong>{data.motion.label}</strong><p>{data.motion.prompt}</p>
    <small>{data.motion.seconds}s · {data.motion.loop ? 'loop pose checked' : 'one-shot'} · {data.variants} context{data.variants === 1 ? '' : 's'}</small>
    <Handle type="source" position={Position.Right} id="out" aria-label={`Output from ${data.motion.label}`} />
  </div>
}
const nodeTypes = { motion: MotionCard }

interface Props {
  plan: MotionPlan
  contexts: GraphContext[]
  selectedId: string
  edgeId: string
  locked: boolean
  onChange(plan: MotionPlan): void
  onNode(id: string): void
  onEdge(id: string): void
  onError(message: string): void
}
export function MotionGraph({ plan, contexts, selectedId, edgeId, locked, onChange, onNode, onEdge, onError }: Props) {
  const nodes = useMemo<GraphNode[]>(() => plan.nodes.map(motion => ({
    id: motion.id, type: 'motion', position: motion.position, selected: motion.id === selectedId && !edgeId,
    data: { motion, entry: plan.entryNodeIds.includes(motion.id), variants: contexts.filter(c => c.path.at(-1) === motion.id).length },
    ariaLabel: `${motion.kind}: ${motion.label}`, deletable: false
  })), [plan, contexts, selectedId, edgeId])
  const edges = plan.edges.map(edge => ({
    ...edge, selected: edge.id === edgeId, sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, color: '#b8d990' },
    label: edge.seconds ? `${edge.seconds}s transition` : 'Direct pose join',
    style: { stroke: edge.id === edgeId ? '#efffcf' : '#8db765', strokeWidth: edge.id === edgeId ? 3 : 2 },
    labelStyle: { fill: '#d3e6c1', fontSize: 10 }, labelBgStyle: { fill: '#1e2c1b' }, deletable: false
  }))
  function connect(connection: Connection) {
    if (locked) return
    if (plan.edges.some(e => e.source === connection.source && e.target === connection.target)) {
      onError('These nodes are already connected. Select the connection to edit it.'); return
    }
    if (plan.edges.length >= 64) { onError('A graph supports up to 64 connections.'); return }
    onChange({ ...plan, edges: [...plan.edges, { id: crypto.randomUUID(), source: connection.source, target: connection.target, seconds: 0.5 }] })
  }
  return <div className="motion-graph" aria-label="Animation graph canvas">
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onConnect={connect}
      onNodeClick={(_, node) => onNode(node.id)} onEdgeClick={(_, edge) => onEdge(edge.id)}
      onNodesChange={changes => {
        if (locked) return
        const positions = changes.flatMap(change => change.type === 'position' && change.position ? [{ id: change.id, position: change.position }] : [])
        if (positions.length) onChange({ ...plan, nodes: plan.nodes.map(node => {
          const change = positions.find(change => change.id === node.id)
          return change ? { ...node, position: change.position } : node
        }) })
      }}
      nodesDraggable={!locked} nodesConnectable={!locked} edgesReconnectable={false} deleteKeyCode={null}
      fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.15} maxZoom={1.8}
      colorMode="dark" proOptions={{ hideAttribution: true }}>
      <Background color="#3b5130" gap={22} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>
}
