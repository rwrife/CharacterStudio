import type { DesignRequest, DesignerConfig } from '../shared/designer'
import { imageProfiles, meshProfiles } from '../shared/designer'

export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export function imageWorkflow(config: DesignerConfig, request: DesignRequest, prefix: string, reference = '', pose = ''): Workflow {
  const size = imageProfiles[config.imageProfile].size
  const identity = !!reference && !!config.ipadapter && !!config.clipVision
  const text = pose
    ? `(single character isolated on a plain pure white background:1.5), full body, front view, (symmetrical T-pose, straight horizontal arms:1.3), palms down, straight legs, feet apart, entire hands and feet visible, centered character sheet, no scenery or props. Art style: ${request.style}. Character identity and backstory, not the setting: ${request.description}. (plain white background:1.5), no text.`
    : `Character and scene: ${request.description}. Art style: ${request.style}. Full body character concept illustration in their environment, clear character silhouette, no text or lettering.`
  const workflow: Workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: config.checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: `cropped, extra limbs, extra fingers, malformed anatomy, duplicate character, watermark, lettering${pose ? ', (scenery, trees, jungle, foliage, ground, furniture, background objects:1.5), bent elbows, arms down, multiple people, shadows' : ''}` } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: size, height: size, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: request.seed, steps: request.steps, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: reference && !identity ? 1 - request.referenceStrength : 1 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix } }
  }
  if (reference) {
    workflow['8'] = { class_type: 'LoadImage', inputs: { image: reference } }
    workflow['9'] = { class_type: 'ImageScale', inputs: { image: ['8', 0], width: size, height: size, crop: 'disabled', upscale_method: 'lanczos' } }
    if (identity) {
      workflow['13'] = { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: config.ipadapter } }
      workflow['14'] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: config.clipVision } }
      workflow['15'] = { class_type: 'IPAdapterAdvanced', inputs: { model: ['1', 0], ipadapter: ['13', 0], clip_vision: ['14', 0], image: ['9', 0], weight: request.referenceStrength * 2, weight_type: 'linear', combine_embeds: 'concat', start_at: 0, end_at: 0.8, embeds_scaling: 'V only' } }
      workflow['5'].inputs.model = ['15', 0]
    } else workflow['4'] = { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } }
  }
  if (pose) {
    workflow['10'] = { class_type: 'LoadImage', inputs: { image: pose } }
    workflow['11'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: config.controlnet } }
    workflow['12'] = { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['2', 0], negative: ['3', 0], control_net: ['11', 0], image: ['10', 0], strength: 1, start_percent: 0, end_percent: 1 } }
    workflow['5'].inputs.positive = ['12', 0]
    workflow['5'].inputs.negative = ['12', 1]
    addIsolation(workflow, config, ['6', 0])
  }
  return workflow
}

function addIsolation(workflow: Workflow, config: DesignerConfig, image: [string, number]) {
  if (!config.backgroundModel) throw new Error('Select installed local background-removal weights. T-pose output must be a transparent character cutout.')
  workflow['16'] = { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: config.backgroundModel } }
  workflow['17'] = { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['16', 0], image } }
  // RemoveBackground returns foreground opacity; JoinImageWithAlpha expects an inverted Comfy mask.
  workflow['18'] = { class_type: 'InvertMask', inputs: { mask: ['17', 0] } }
  workflow['19'] = { class_type: 'JoinImageWithAlpha', inputs: { image, alpha: ['18', 0] } }
  workflow['7'].inputs.images = ['19', 0]
}

export function isolationWorkflow(config: DesignerConfig, prefix: string, image: string): Workflow {
  const workflow: Workflow = {
    '1': { class_type: 'LoadImage', inputs: { image } },
    '7': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: prefix } }
  }
  addIsolation(workflow, config, ['1', 0])
  return workflow
}

export function meshWorkflow(config: DesignerConfig, request: DesignRequest, prefix: string, image: string): Workflow {
  return {
    '1': { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: config.meshCheckpoint } },
    '2': { class_type: 'LoadImage', inputs: { image } },
    '3': { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['1', 1], image: ['13', 0], crop: 'none' } },
    '4': { class_type: 'Hunyuan3Dv2Conditioning', inputs: { clip_vision_output: ['3', 0] } },
    '5': { class_type: 'EmptyLatentHunyuan3Dv2', inputs: { resolution: 3072, batch_size: 1 } },
    '6': { class_type: 'KSampler', inputs: { model: ['10', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['5', 0], seed: request.seed, steps: request.steps, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '7': { class_type: 'VAEDecodeHunyuan3D', inputs: { samples: ['6', 0], vae: ['1', 2], num_chunks: 8000, octree_resolution: meshProfiles[config.meshProfile].resolution } },
    '8': { class_type: 'VoxelToMesh', inputs: { voxel: ['7', 0], algorithm: 'basic', threshold: 0.6 } },
    '9': { class_type: 'SaveGLB', inputs: { mesh: ['8', 0], filename_prefix: prefix } },
    '10': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 1, sampling: 'flow' } },
    '11': { class_type: 'InvertMask', inputs: { mask: ['2', 1] } },
    '12': { class_type: 'EmptyImage', inputs: { width: imageProfiles[config.imageProfile].size, height: imageProfiles[config.imageProfile].size, batch_size: 1, color: 0xffffff } },
    '13': { class_type: 'ImageCompositeMasked', inputs: { destination: ['12', 0], source: ['2', 0], mask: ['11', 0], x: 0, y: 0, resize_source: false } }
  }
}
