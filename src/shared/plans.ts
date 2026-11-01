import type { BatchItem, MotionNode, MotionPlan, BatchRequest, Character, GraphContext } from './types'

export const MAX_GRAPH_CONTEXTS = 64
const singleSegment = (text: string) => text.trim().replace(/[.!?]+/g, ',').replace(/,\s*$/, '')

export function contextualPrompt(node: MotionNode, inheritedStance: string, hasParent: boolean): string {
  if (node.legacySegments) return node.prompt
  const action = singleSegment(node.prompt)
  const stance = singleSegment(node.kind === 'state' ? node.stance || node.prompt : inheritedStance)
  if (node.kind === 'state')
    return `A person maintains this state: ${action}${node.stance ? `, posture: ${stance}` : ''}${node.loop ? ', subtle continuous motion returning to the starting pose' : ''}`
  return `${hasParent ? 'Starting from the supplied previous body pose, which takes precedence over posture guidance, ' : ''}${stance ? `with posture context "${stance}", ` : ''}${action}, preserve the starting stance unless these action instructions explicitly change it${node.stance ? `, resulting posture: ${singleSegment(node.stance)}` : ''}`
}

export function expandGraph(plan: MotionPlan): GraphContext[] {
  const byId = new Map(plan.nodes.map(node => [node.id, node]))
  if (byId.size !== plan.nodes.length) throw new Error('Motion node IDs must be unique.')
  if (!plan.entryNodeIds.length) throw new Error('Choose at least one starting node.')
  if (new Set(plan.entryNodeIds).size !== plan.entryNodeIds.length) throw new Error('Starting nodes must be unique.')
  const pairs = new Set<string>(), edgeIds = new Set<string>()
  for (const edge of plan.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) throw new Error('A connection references a missing node.')
    const pair = `${edge.source}:${edge.target}`
    if (pairs.has(pair) || edgeIds.has(edge.id)) throw new Error('Duplicate connections are not allowed.')
    pairs.add(pair); edgeIds.add(edge.id)
    if (byId.get(edge.source)!.inPlace !== byId.get(edge.target)!.inPlace)
      throw new Error('Connected nodes must use the same root-motion mode.')
  }
  const contexts: GraphContext[] = [], reached = new Set<string>()
  function visit(id: string, parent: GraphContext | undefined, total: number, transitionSeconds: number) {
    const node = byId.get(id)
    if (!node) throw new Error('A starting node is missing.')
    if (contexts.length >= MAX_GRAPH_CONTEXTS) throw new Error(`This graph expands beyond ${MAX_GRAPH_CONTEXTS} path-specific clips per character. Split it into smaller graphs.`)
    const path = [...(parent?.path ?? []), id]
    const duration = node.seconds * (node.legacySegments ? node.prompt.split('.').filter(p => p.trim()).length : 1)
    if (total + transitionSeconds + duration > 60)
      throw new Error(`Path ending at "${node.label}" exceeds 60 seconds including transitions.`)
    const inheritedStance = parent?.resultingStance ?? ''
    const context: GraphContext = {
      key: path.join('/'), path, pathLabel: path.map(n => byId.get(n)!.label).join(' → '),
      ...(parent ? { parentKey: parent.key } : {}),
      inheritedStance, resultingStance: node.stance || (node.kind === 'state' ? node.prompt : inheritedStance),
      effectivePrompt: contextualPrompt(node, inheritedStance, !!parent), transitionSeconds,
      cycleEnd: parent?.path.includes(id) ?? false
    }
    contexts.push(context); reached.add(id)
    // A cycle emits its returning node once, then stops rather than creating an infinite queue.
    if (!context.cycleEnd)
      for (const edge of plan.edges.filter(e => e.source === id))
        visit(edge.target, context, total + transitionSeconds + duration, edge.seconds)
  }
  for (const entry of plan.entryNodeIds) visit(entry, undefined, 0, 0)
  const unreachable = plan.nodes.filter(n => !reached.has(n.id))
  if (unreachable.length) throw new Error(`Connect or mark these nodes as starting nodes: ${unreachable.map(n => n.label).join(', ')}.`)
  return contexts
}

export function createBatchItems(plan: MotionPlan, request: BatchRequest, characters: Character[], uuid: () => string): BatchItem[] {
  const contexts = expandGraph(plan)
  return request.characterIds.flatMap((characterId, index) => {
    const character = characters.find(c => c.id === characterId)
    if (!character) throw new Error(`Character ${characterId} is no longer in the workspace.`)
    const ids = new Map<string, string>()
    return contexts.map(context => {
      const node = plan.nodes.find(n => n.id === context.path.at(-1))!
      const id = uuid(); ids.set(context.key, id)
      return {
        id, characterId, characterName: character.name, nodeId: node.id, label: node.label,
        seed: (node.seed + index * request.seedStride) % 4294967296, status: 'pending' as const,
        context: structuredClone(context), ...(context.parentKey ? { parentItemId: ids.get(context.parentKey)! } : {})
      }
    })
  })
}
