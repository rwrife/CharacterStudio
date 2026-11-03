import { handPrefix, handSides, handTemplate } from '../shared/hand-rig'
import type { RigSetup } from '../shared/types'

export function HandRigControls({ setup, disabled, onChange }: { setup: RigSetup; disabled: boolean; onChange: (setup: RigSetup, selected: string) => void }) {
  return <section aria-label="Hand rig fitting">
    <h3>Hand rig detail</h3>
    <p className="fine-print">Wrist only keeps the mesh's finger shape. Basic adds thumb, index and grouped remaining fingers. Changing detail rebuilds weights; Wrist only clears finger controls and does not bake a grip.</p>
    {handSides.map(side => {
      const config = setup.hands?.[side]
      const prefix = handPrefix(side)
      return <div key={side}>
        <label className="field-label" htmlFor={`${side}-rig-detail`}>{prefix} hand rig detail</label>
        <select id={`${side}-rig-detail`} disabled={disabled} value={config?.detail ?? 'wrist'} onChange={event => {
          const detail = event.target.value === 'basic' ? 'basic' : 'wrist'
          onChange(handTemplate(setup, side, detail), `${prefix}${detail === 'basic' ? 'Thumb1' : 'Hand'}`)
        }}>
          <option value="wrist">Wrist only - fixed finger shape</option>
          <option value="basic">Basic three-chain</option>
          <option value="individual" disabled>Individual fingers - planned</option>
        </select>
        {config?.detail === 'basic' && <>
          <div className="xyz-fields">{(['thumb', 'index', 'fingers'] as const).map(chain => <label key={chain}>{chain === 'fingers' ? 'Grouped' : chain}
            <input aria-label={`${prefix} ${chain} influence radius`} type="number" step="0.001" min="0.003" max="0.08" disabled={disabled}
              value={config[`${chain}Radius`]} onChange={event => {
                if (!Number.isFinite(event.target.valueAsNumber)) return
                onChange({ ...setup, hands: { left: { detail: 'wrist' }, right: { detail: 'wrist' }, ...setup.hands,
                  [side]: { ...config, [`${chain}Radius`]: event.target.valueAsNumber } } }, `${prefix}${chain === 'fingers' ? 'Fingers' : chain === 'thumb' ? 'Thumb' : 'Index'}1`)
              }} />
          </label>)}</div>
          <button className="text-button full" disabled={disabled} onClick={() => onChange(handTemplate(setup, side, 'basic'), `${prefix}Thumb1`)}>Reset {side} hand template</button>
        </>}
      </div>
    })}
    <p className="fine-print">Templates are not automatic hand detection. Place point 1 at each knuckle, subsequent points at bends and the final point at the tip. PalmNormal points out of the back of the hand. Radii are in meters and bound each chain's influence; inspect thumb/index separation in both views. Fused or missing digits cannot be reconstructed.</p>
  </section>
}
