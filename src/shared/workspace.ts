export interface ProcessStep {
  id: string
  label: string
  detail?: string
  complete?: boolean
  state?: 'running' | 'failed' | 'cancelled' | 'blocked' | 'imported'
}

export function processStepStatus(step: ProcessStep, current: boolean): string {
  const state = step.state ? step.state[0].toUpperCase() + step.state.slice(1) : step.complete ? 'Complete' : 'Pending'
  return current ? state === 'Pending' ? 'Current step' : `Current step · ${state}` : state
}

export function mergeSettingsDraft<T extends object>(base: T, draft: T, current: T): T {
  const result = { ...current }
  for (const key of new Set([...Object.keys(base), ...Object.keys(draft)]) as Set<keyof T>) {
    if (JSON.stringify(base[key]) === JSON.stringify(draft[key])) continue
    if (JSON.stringify(current[key]) !== JSON.stringify(base[key]) && JSON.stringify(current[key]) !== JSON.stringify(draft[key])) {
      throw new Error(`Settings changed elsewhere (${String(key)}). Discard this draft and reopen Model Settings to review the saved values.`)
    }
    if (Object.hasOwn(draft, key)) result[key] = draft[key]
    else delete result[key]
  }
  return result
}
