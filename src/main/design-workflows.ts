import type { DesignRequest, DesignerConfig } from '../shared/designer'
import { imageProfiles, meshProfiles } from '../shared/designer'

export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export function imageWorkflow(config: DesignerConfig, request: DesignRequest, prefix: string, reference = '', pose = ''): Workflow {
  const size = imageProfiles[config.imageProfile].size
  const text = pose
    ? `Character design: ${request.description}. Art style: ${request.style}. The same character, alone, full body, front view, strict symmetrical T-pose, both arms straight horizontally at shoulder height, palms down, legs straight, feet apart, entire hands and feet visible, centered, isolated on a plain pure white background, no scenery, no props, no text.`
    : `Character and scene: ${request.description}. Art style: ${request.style}. Full body character concept illustration in their environment, clear character silhouette, no text or lettering.`
  const workflow: Workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: config.checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: `cropped, extra limbs, extra fingers, malformed anatomy, duplicate character, watermark, lettering${pose ? ', scenery, trees, jungle, furniture, bent elbows, arms down, multiple people, shadows, background objects' : ''}` } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: size, height: size, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: request.seed, steps: request.steps, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: reference ? 1 - request.referenceStrength : 1 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix } }
  }
  if (reference) {
    workflow['8'] = { class_type: 'LoadImage', inputs: { image: reference } }
    workflow['9'] = { class_type: 'ImageScale', inputs: { image: ['8', 0], width: size, height: size, crop: 'disabled', upscale_method: 'lanczos' } }
    workflow['4'] = { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } }
  }
  if (pose) {
    workflow['10'] = { class_type: 'LoadImage', inputs: { image: pose } }
    workflow['11'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: config.controlnet } }
    workflow['12'] = { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['2', 0], negative: ['3', 0], control_net: ['11', 0], image: ['10', 0], strength: 1, start_percent: 0, end_percent: 1 } }
    workflow['5'].inputs.positive = ['12', 0]
    workflow['5'].inputs.negative = ['12', 1]
  }
  return workflow
}

export function meshWorkflow(config: DesignerConfig, request: DesignRequest, prefix: string, image: string): Workflow {
  return {
    '1': { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: config.meshCheckpoint } },
    '2': { class_type: 'LoadImage', inputs: { image } },
    '3': { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['1', 1], image: ['2', 0], crop: 'none' } },
    '4': { class_type: 'Hunyuan3Dv2Conditioning', inputs: { clip_vision_output: ['3', 0] } },
    '5': { class_type: 'EmptyLatentHunyuan3Dv2', inputs: { resolution: 3072, batch_size: 1 } },
    '6': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['5', 0], seed: request.seed, steps: request.steps, cfg: 5, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    '7': { class_type: 'VAEDecodeHunyuan3D', inputs: { samples: ['6', 0], vae: ['1', 2], num_chunks: 8000, octree_resolution: meshProfiles[config.meshProfile].resolution } },
    '8': { class_type: 'VoxelToMesh', inputs: { voxel: ['7', 0], algorithm: 'basic', threshold: 0.6 } },
    '9': { class_type: 'SaveGLB', inputs: { mesh: ['8', 0], filename_prefix: prefix } }
  }
}
