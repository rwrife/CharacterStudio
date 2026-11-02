import type { AiStage } from '../shared/ai'
import type { DesignerConfig, DesignerReadiness } from '../shared/designer'
import { imageProfiles, meshProfiles, tposeEditProfile } from '../shared/designer'

function InstalledModel({ id, label, value = '', names = [], disabled, onChange }: {
  id: string; label: string; value?: string; names?: string[]; disabled: boolean; onChange: (value: string) => void
}) {
  return <div>
    <label className="field-label" htmlFor={id}>{label}</label>
    <select id={id} disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">Select installed local weights</option>
      {value && !names.includes(value) && <option value={value}>{value} (not detected)</option>}
      {names.map(name => <option key={name}>{name}</option>)}
    </select>
    <details className="model-advanced"><summary>Custom {label.toLowerCase()}</summary>
      <label className="field-label" htmlFor={`${id}-custom`}>Custom checkpoint ID</label>
      <input id={`${id}-custom`} aria-label={`Custom ${label.toLowerCase()}`} disabled={disabled} value={value}
        onChange={event => onChange(event.target.value)} />
      <p className="fine-print">Use an installed, compatible model ID. An unavailable model is preserved and reported as an error, never replaced automatically.</p>
    </details>
  </div>
}

export function NativeModelFields({ stage, config, ready, disabled, budgetText, onChange }: {
  stage: AiStage | 'global'; config: DesignerConfig; ready?: DesignerReadiness; disabled: boolean; budgetText: (gb: number) => string; onChange: (config: DesignerConfig) => void
}) {
  const fields = (items: { key: keyof DesignerConfig; label: string; names?: string[] }[]) => items.map(({ key, label, names }) =>
    <InstalledModel key={key} id={`design-${key}`} label={label} value={String(config[key] ?? '')} names={names} disabled={disabled}
      onChange={value => onChange({ ...config, [key]: value })} />)
  return <section aria-label="Built-in local model choices">
    <h3>Built-in local model choices</h3>
    {stage === 'scene' && <>
      <label className="field-label" htmlFor="image-profile">Image model family</label>
      <select id="image-profile" disabled={disabled} value={config.imageProfile} onChange={event => onChange({
        ...config, imageProfile: event.target.value === 'sdxl' ? 'sdxl' : 'sd15', checkpoint: '', controlnet: '', ipadapter: '', clipVision: ''
      })}>{Object.entries(imageProfiles).map(([key, profile]) => <option value={key} key={key}>{profile.label} / ~{profile.gb} GiB estimated / {budgetText(profile.gb)}</option>)}</select>
      <InstalledModel id="image-checkpoint" label="Installed image checkpoint" value={config.checkpoint}
        names={ready?.checkpoints.filter(name => !/hunyuan|flux|sd3/i.test(name))} disabled={disabled} onChange={checkpoint => onChange({ ...config, checkpoint })} />
      <details className="model-advanced"><summary>Scene reference adapters</summary>
        <label className="field-label" htmlFor="design-ipadapter">Scene reference adapter</label>
        <select id="design-ipadapter" disabled={disabled} value={config.ipadapter ?? ''} onChange={event => onChange({
          ...config, ipadapter: event.target.value, ...(event.target.value ? {} : { clipVision: '' })
        })}><option value="">Basic img2img (no adapter)</option>
          {config.ipadapter && !ready?.ipadapters.includes(config.ipadapter) && <option value={config.ipadapter}>{config.ipadapter} (not detected)</option>}
          {ready?.ipadapters.map(name => <option key={name}>{name}</option>)}
        </select>
        {config.ipadapter && fields([{ key: 'clipVision', label: 'Adapter CLIP Vision', names: ready?.clipVision }])}
        <p className="fine-print">Optional for scene references, not T-pose editing. Match the SD 1.5/SDXL adapter to the scene model and vision weights; allow about 2 GiB extra memory.</p>
      </details>
    </>}
    {stage === 'tpose' && <>
      <p className="fine-print">{tposeEditProfile.label}. Edits the completed scene, not the brief. About {tposeEditProfile.gb} GiB estimated, plus independent cutout removal. Four distilled steps in the built-in preset; no SD/OpenPose fallback.</p>
      {fields([
        { key: 'editModel', label: 'T-pose edit model', names: ready?.diffusionModels },
        { key: 'editTextEncoder', label: 'Edit text encoder', names: ready?.textEncoders },
        { key: 'editVae', label: 'Edit autoencoder', names: ready?.vaes }
      ])}
    </>}
    {stage === 'cutout' && <>
      {fields([{ key: 'backgroundModel', label: 'Background removal', names: ready?.backgroundModels }])}
      <p className="fine-print">Local BiRefNet creates a transparent cutout. Opaque or border-touching masks cannot feed 3D. Allow about 2 GiB extra memory.</p>
    </>}
    {stage === 'mesh' && <>
      <label className="field-label" htmlFor="mesh-profile">3D model profile</label>
      <select id="mesh-profile" disabled={disabled} value={config.meshProfile} onChange={event => onChange({
        ...config, meshProfile: event.target.value === 'textured' ? 'textured' : event.target.value === 'standard' ? 'standard' : 'mini', meshCheckpoint: ''
      })}>{Object.entries(meshProfiles).map(([key, profile]) => <option key={key} value={key}>{profile.label} / ~{profile.gb} GiB estimated / {budgetText(profile.gb)}</option>)}</select>
      {config.meshProfile === 'textured' ? fields([
        { key: 'meshTextureModel', label: 'Textured 3D model', names: ready?.diffusionModels },
        { key: 'meshVision', label: '3D vision encoder', names: ready?.clipVision },
        { key: 'meshShapeVae', label: '3D shape decoder', names: ready?.vaes },
        { key: 'meshTextureVae', label: '3D texture decoder', names: ready?.vaes }
      ]) : <InstalledModel id="mesh-checkpoint" label="Installed 3D checkpoint" value={config.meshCheckpoint}
        names={ready?.checkpoints.filter(name => /hunyuan/i.test(name))} disabled={disabled} onChange={meshCheckpoint => onChange({ ...config, meshCheckpoint })} />}
      <p className="fine-print">Hunyuan3D creates geometry; TRELLIS.2 creates a new textured GLB. Both are unrigged. Output quality is configured in the 3D step. Unsupported/missing weights are errors, never geometry-only fallbacks.</p>
    </>}
    {stage === 'naming' && <>
      <InstalledModel id="title-model" label="Automatic title model" value={config.titleModel} names={ready?.titleModels}
        disabled={disabled} onChange={titleModel => onChange({ ...config, titleModel })} />
      <p className="fine-print">Optional local Ollama instruction model on port 11434. Leave unselected to provide your own title. Cloud naming models are not accepted by this built-in preset.</p>
      {ready?.titleError && <p className="fine-print">{ready.titleError}</p>}
    </>}
  </section>
}
