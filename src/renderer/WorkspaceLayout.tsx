import { useEffect, useRef, type ReactNode } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { processStepStatus, type ProcessStep } from '../shared/workspace'

export function WorkspaceLayout({ id, labelledBy, hidden, step, children, className = '' }: {
  id: string; labelledBy: string; hidden: boolean; step: string; children: ReactNode; className?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    root.current?.querySelectorAll('.workflow-settings, .workflow-main').forEach(panel => panel.scrollTo({ top: 0 }))
  }, [step])
  return <div ref={root} id={id} role="tabpanel" aria-labelledby={labelledBy} hidden={hidden} className={`workflow-layout ${className}`}>{children}</div>
}

export function ProcessStepper({ label, steps, current, onSelect }: {
  label: string; steps: ProcessStep[]; current: string; onSelect: (id: string) => void
}) {
  return <nav className="process-stepper" aria-label={label}>
    <ol>{steps.map((step, index) => {
      const selected = current === step.id
      const status = processStepStatus(step, selected)
      return <li key={step.id}>
        <button className={`process-step ${selected ? 'current' : ''} ${step.state ?? ''}`} aria-label={step.label}
          aria-current={selected ? 'step' : undefined} aria-describedby={`${label.replaceAll(' ', '-')}-${step.id}-status`}
          onClick={() => onSelect(step.id)}>
          <span className="process-number" aria-hidden="true">{index + 1}</span>
          <span className="process-copy"><strong>{step.label}</strong><small id={`${label.replaceAll(' ', '-')}-${step.id}-status`}>
            {step.state === 'running' ? <LoaderCircle size={12} className="spin" /> : step.complete && !step.state ? <Check size={12} /> : null}
            {status}
          </small></span>
        </button>
      </li>
    })}</ol>
  </nav>
}
