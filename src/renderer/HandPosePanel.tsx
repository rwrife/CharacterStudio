import type { HandPose, RigSetup, Vec3 } from '../shared/types'
import { handPrefix, handSides, openFingers } from '../shared/hand-rig'
import { FingerPoseEditor } from './FingerPoseEditor'

export function HandPosePanel({ pose, saved, setup, disabled, dirty, onChange, onSave, onClose, onFit, onBake, onPreviewTime }: {
  pose: HandPose
  saved: HandPose
  setup: RigSetup
  disabled: boolean
  dirty: boolean
  onChange: (pose: HandPose) => void
  onSave: () => void
  onClose: () => void
  onFit: () => void
  onBake: () => void
  onPreviewTime: (time: number) => void
}) {
  return <section aria-label="Hand pose controls">
    <div className="section-kicker">HAND RIGGING</div>
    <h2>Hand pose</h2>
    <p className="panel-description">Rotate the existing hand shape without rebuilding skin weights. Saved offsets apply to new character animations, not completed takes.</p>
    <p className="fine-print">{handSides.map(side => `${handPrefix(side)}: ${setup.hands?.[side].detail === 'basic' ? 'Basic three-chain' : 'Wrist only'}`).join(' / ')}</p>
    <button className="secondary full" disabled={disabled || dirty} onClick={onFit}>Change hand rig detail & fitting</button>
    <p className="fine-print">Wrist only cannot close fingers. Basic curls thumb, index and grouped remaining fingers using your fitted points; it cannot repair fused geometry. Individual fingers are not available yet.</p>
    {(['left', 'right'] as const).map(side => <div key={side}>
      <label className="field-label">{side === 'left' ? 'Left' : 'Right'} wrist <span>degrees</span></label>
      <div className="xyz-fields">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis}>{axis}
        <input aria-label={`${side === 'left' ? 'Left' : 'Right'} wrist ${axis}`} type="number" min="-180" max="180" step="1"
          disabled={disabled} value={pose[side][index]} onChange={event => {
            const value = event.target.valueAsNumber
            if (!Number.isFinite(value)) return
            const rotation: Vec3 = [...pose[side]]
            rotation[index] = value
            onChange({ ...pose, [side]: rotation })
          }} />
      </label>)}</div>
    </div>)}
    <FingerPoseEditor value={pose.version === 2 ? pose : { fingers: { left: openFingers(), right: openFingers() } }}
      setup={setup} disabled={disabled} onPreviewTime={onPreviewTime}
      onChange={value => onChange({ version: 2, detail: 'basic', left: pose.left, right: pose.right, ...value })} />
    <p className="fine-print">XYZ offsets use the normalized character's rest axes: X right, Y up, Z forward. They follow the moving wrist; these are not anatomical bend/twist axes or a world-space hand lock.</p>
    <button className="text-button full" disabled={disabled} onClick={() => onChange({ ...pose, right: [...pose.left] })}>Copy left rotation to right</button>
    <p className="fine-print">Copy uses the same signed angles, not a mirrored grip.</p>
    <button className="secondary full" disabled={disabled} onClick={() => onChange({ ...pose, left: [0, 0, 0], right: [0, 0, 0] })}>Reset wrist rotations</button>
    <p className="fine-print" role="status">{dirty ? 'Unsaved hand pose preview. Save or discard before leaving or generating motion.' : 'Saved hand pose. Completed takes keep their original offsets.'}</p>
    <button className="primary full" disabled={disabled || !dirty} onClick={onSave}>Save hand pose</button>
    <button className="text-button full" disabled={disabled || !dirty} onClick={() => onChange(structuredClone(saved))}>Discard hand pose changes</button>
    {handSides.some(side => setup.hands?.[side].detail === 'basic') && <>
      <button className="secondary full" disabled={disabled || dirty || pose.version !== 2 || !!pose.keyframes} onClick={onBake}>Bake fixed grip as new wrist-only character</button>
      <p className="fine-print">Disable finger animation at the desired preview pose, then save before baking. Creates a separate variation with the saved finger shape and 22 body bones. Originals are kept; wrist rotations stay editable.</p>
    </>}
    <button className="secondary full" disabled={disabled || dirty} onClick={onClose}>Back to motion controls</button>
  </section>
}
