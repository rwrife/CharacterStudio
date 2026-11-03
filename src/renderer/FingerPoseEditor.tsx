import { useState } from 'react'
import { fingerValuesAt } from '../shared/hand-animation'
import { handPrefix, handSides, openFingers } from '../shared/hand-rig'
import type { FingerPose, FingerTrack, HandSide, RigSetup } from '../shared/types'

export function FingerPoseEditor({ value, setup, disabled, onChange, onPreviewTime }: {
  value: FingerTrack; setup: RigSetup; disabled: boolean
  onChange: (value: FingerTrack) => void; onPreviewTime?: (time: number) => void
}) {
  const [time, setTime] = useState(0)
  const [error, setError] = useState('')
  const fingers = fingerValuesAt(value, time)
  const sides = handSides.filter(side => setup.hands?.[side].detail === 'basic')
  function preview(next: number) { setTime(next); onPreviewTime?.(next) }
  function change(side: HandSide, pose: FingerPose) {
    const updated = { ...fingers, [side]: pose }
    if (!value.keyframes) { onChange({ fingers: updated }); return }
    if (value.keyframes.length >= 16 && !value.keyframes.some(key => key.time === time)) {
      setError('At most 16 hand keys are supported. Remove an interior key before adding another.')
      return
    }
    setError('')
    const keyframes = [...value.keyframes.filter(key => key.time !== time), { time, fingers: updated }].sort((a, b) => a.time - b.time)
    onChange({ fingers: keyframes[0].fingers, keyframes })
  }
  if (!sides.length) return <p className="fine-print">Build Basic three-chain hands to use finger controls.</p>
  return <section aria-label="Finger animation controls">
    <label className="checkbox"><input type="checkbox" disabled={disabled} checked={!!value.keyframes} onChange={event => {
      onChange(event.target.checked ? { fingers, keyframes: [{ time: 0, fingers }, { time: 1, fingers }] } : { fingers })
      preview(0)
    }} /> Animate fingers over clip</label>
    <button className="text-button full" disabled={disabled} onClick={() => {
      const open = { left: openFingers(), right: openFingers() }, closed = structuredClone(open)
      for (const side of sides) closed[side] = { thumb: 1, index: 1, fingers: 1, opposition: 0.6 }
      onChange({ fingers: open, keyframes: [{ time: 0, fingers: open }, { time: 0.5, fingers: closed }, { time: 1, fingers: open }] })
      preview(0)
    }}>Open-close-open hand animation</button>
    {value.keyframes && <>
      <label className="field-label" htmlFor="hand-key-time">Hand key preview <span>{Math.round(time * 100)}% of clip</span></label>
      <input id="hand-key-time" aria-label="Hand key preview time" type="range" min="0" max="1" step="0.01"
        disabled={disabled} value={time} onChange={event => preview(Number(event.target.value))} />
      <p className="fine-print">Edit controls at the preview time to add/update a key. Keys: {value.keyframes.map(key => `${Math.round(key.time * 100)}%`).join(', ')}. Linear interpolation; no collision or contact solver.</p>
      <button className="text-button full" disabled={disabled || time === 0 || time === 1 || !value.keyframes.some(key => key.time === time)}
        onClick={() => { onChange({ fingers: value.fingers, keyframes: value.keyframes!.filter(key => key.time !== time) }); setError('') }}>Remove selected hand key</button>
    </>}
    {error && <p role="alert">{error}</p>}
    {sides.map(side => <section key={side} aria-label={`${handPrefix(side)} finger pose`}>
      <h3>{handPrefix(side)} fingers</h3>
      <div className="prompt-suggestions">{(['Open', 'Relaxed', 'Fist'] as const).map(preset =>
        <button key={preset} disabled={disabled} onClick={() => {
          const closure = preset === 'Open' ? 0 : preset === 'Relaxed' ? 0.25 : 1
          change(side, { thumb: closure, index: closure, fingers: closure, opposition: closure * 0.6 })
        }}>{`${handPrefix(side)} ${preset}`}</button>)}</div>
      <label className="field-label" htmlFor={`${side}-closure`}>Close whole hand</label>
      <input id={`${side}-closure`} aria-label={`${handPrefix(side)} hand closure`} type="range" min="0" max="1" step="0.01"
        disabled={disabled} value={fingers[side].fingers} onChange={event => {
          const closure = Number(event.target.value)
          change(side, { thumb: closure, index: closure, fingers: closure, opposition: closure * 0.6 })
        }} />
      <div className="two-fields">{(['thumb', 'index', 'fingers', 'opposition'] as const).map(control => <label key={control}>
        {control === 'fingers' ? 'Grouped finger curl' : control === 'opposition' ? 'Thumb opposition' : `${control} curl`}
        <input aria-label={`${handPrefix(side)} ${control}`} type="number" min="0" max="1" step="0.05" disabled={disabled}
          value={fingers[side][control]} onChange={event => {
            if (Number.isFinite(event.target.valueAsNumber)) change(side, { ...fingers[side], [control]: event.target.valueAsNumber })
          }} />
      </label>)}</div>
    </section>)}
  </section>
}
