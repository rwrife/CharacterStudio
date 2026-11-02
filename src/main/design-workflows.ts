import type { DesignRequest, DesignerConfig } from '../shared/designer'
import { handAnatomyNegative, imageProfiles, meshProfiles, scenePrompt, specifiesHandAnatomy, texturedMeshSettings, tposeEditProfile, tposePrompt } from '../shared/designer'

export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export function imageWorkflow(config: DesignerConfig, request: DesignRequest, prefix: string, reference = ''): Workflow {
  const size = imageProfiles[config.imageProfile].size
  const identity = !!reference && !!config.ipadapter && !!config.clipVision
  const defaultHands = !specifiesHandAnatomy(request)
  const text = scenePrompt(request)
  const negative = `cropped, extra limbs, ${defaultHands ? `${handAnatomyNegative}, ` : ''}malformed anatomy, duplicate character, crowd, extra people, watermark, logo, lettering`
  const workflow: Workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: config.checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: negative } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: size, height: size, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: request.seed, steps: request.steps, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: reference && !identity ? 1 - request.referenceStrength : 1 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix } }
  }
  if (reference) {
    workflow['8'] = { class_type: 'LoadImage', inputs: { image: reference } }
    // Center-crop instead of stretching so faces and bodies in non-square photos keep their proportions.
    workflow['9'] = { class_type: 'ImageScale', inputs: { image: ['8', 0], width: size, height: size, crop: 'center', upscale_method: 'lanczos' } }
    if (identity) {
      workflow['13'] = { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: config.ipadapter } }
      workflow['14'] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: config.clipVision } }
      workflow['15'] = { class_type: 'IPAdapterAdvanced', inputs: { model: ['1', 0], ipadapter: ['13', 0], clip_vision: ['14', 0], image: ['9', 0], weight: request.referenceStrength * 2, weight_type: 'linear', combine_embeds: 'concat', start_at: 0, end_at: 0.8, embeds_scaling: 'V only' } }
      workflow['5'].inputs.model = ['15', 0]
    } else workflow['4'] = { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } }
  }
  return workflow
}

export function tposeWorkflow(config: DesignerConfig, request: DesignRequest, prefix: string, scene: string, isolate = true): Workflow {
  if (!scene || !config.editModel || !config.editTextEncoder || !config.editVae)
    throw new Error('T-pose editing requires a scene image and installed FLUX.2 klein 4B, Qwen 3 4B and FLUX.2 VAE weights.')
  const workflow: Workflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: config.editModel, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: config.editTextEncoder, type: 'flux2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: config.editVae } },
    '4': { class_type: 'LoadImage', inputs: { image: scene } },
    '5': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['4', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 } },
    '6': { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['23', 0], filename_prefix: prefix } },
    '8': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: tposePrompt(request) } },
    '9': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['8', 0] } },
    '10': { class_type: 'ReferenceLatent', inputs: { conditioning: ['8', 0], latent: ['6', 0] } },
    '11': { class_type: 'ReferenceLatent', inputs: { conditioning: ['9', 0], latent: ['6', 0] } },
    '12': { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['10', 0], negative: ['11', 0], cfg: 1 } },
    '13': { class_type: 'EmptyFlux2LatentImage', inputs: { width: ['15', 0], height: ['15', 1], batch_size: 1 } },
    '14': { class_type: 'Flux2Scheduler', inputs: { steps: tposeEditProfile.steps, width: ['15', 0], height: ['15', 1] } },
    '15': { class_type: 'GetImageSize', inputs: { image: ['5', 0] } },
    '20': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '21': { class_type: 'RandomNoise', inputs: { noise_seed: request.seed } },
    '22': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['21', 0], guider: ['12', 0], sampler: ['20', 0], sigmas: ['14', 0], latent_image: ['13', 0] } },
    '23': { class_type: 'VAEDecode', inputs: { samples: ['22', 0], vae: ['3', 0] } }
  }
  if (isolate) addIsolation(workflow, config, ['23', 0])
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
  if (config.meshProfile === 'textured') return texturedMeshWorkflow(config, request, prefix, image)
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

function texturedMeshWorkflow(config: DesignerConfig, request: DesignRequest, prefix: string, image: string): Workflow {
  const quality = texturedMeshSettings(config)
  const workflow: Workflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: config.meshTextureModel, weight_dtype: 'default' } },
    '2': { class_type: 'LoadImage', inputs: { image } },
    '3': { class_type: 'CLIPVisionLoader', inputs: { clip_name: config.meshVision } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: config.meshShapeVae } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: config.meshTextureVae } },
    '6': { class_type: 'InvertMask', inputs: { mask: ['2', 1] } },
    '7': { class_type: 'ImageCropToMask', inputs: { images: ['2', 0], masks: ['6', 0], width: 1024, height: 1024, pad_factor: 1, grow_mask: 0, background: '#000000' } },
    '8': { class_type: 'Trellis2Conditioning', inputs: { clip_vision_model: ['3', 0], image: ['7', 0] } },
    '9': { class_type: 'SaveGLB', inputs: { mesh: ['28', 0], filename_prefix: prefix } },
    '10': { class_type: 'CFGOverride', inputs: { model: ['1', 0], cfg: 1, start_percent: 0.667, end_percent: 1 } },
    '11': { class_type: 'RescaleCFG', inputs: { model: ['10', 0], multiplier: 0.7 } },
    '12': { class_type: 'ModelSamplingSD3', inputs: { model: ['11', 0], shift: 5 } },
    '13': { class_type: 'EmptyTrellis2LatentStructure', inputs: { batch_size: 1 } },
    '14': { class_type: 'KSampler', inputs: { model: ['12', 0], positive: ['8', 0], negative: ['8', 1], latent_image: ['13', 0], seed: request.seed, steps: 12, cfg: 7.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '15': { class_type: 'VaeDecodeStructureTrellis2', inputs: { samples: ['14', 0], vae: ['4', 0], resolution: '32' } },
    '16': { class_type: 'Trellis2ShapeStage', inputs: { positive: ['8', 0], negative: ['8', 1], voxel: ['15', 0] } },
    '17': { class_type: 'CFGOverride', inputs: { model: ['1', 0], cfg: 1, start_percent: 0.769, end_percent: 1 } },
    '18': { class_type: 'RescaleCFG', inputs: { model: ['17', 0], multiplier: 0.5 } },
    '19': { class_type: 'KSampler', inputs: { model: ['18', 0], positive: ['16', 0], negative: ['16', 1], latent_image: ['16', 2], seed: request.seed, steps: 20, cfg: 7.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '20': { class_type: 'VaeDecodeShapeTrellis', inputs: { samples: ['19', 0], vae: ['4', 0] } },
    '21': { class_type: 'Trellis2TextureStage', inputs: { positive: ['16', 0], negative: ['16', 1], shape_latent: ['19', 0] } },
    '22': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['21', 0], negative: ['21', 1], latent_image: ['21', 2], seed: request.seed, steps: 12, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '23': { class_type: 'VaeDecodeTextureTrellis', inputs: { samples: ['22', 0], vae: ['5', 0], shape_subdivides: ['20', 1] } },
    '24': { class_type: 'DecimateMesh', inputs: { mesh: ['29', 0], target_face_count: quality.faceCount, placement_mode: 'midpoint' } },
    '25': { class_type: 'UnwrapMesh', inputs: { mesh: ['24', 0], segmenter: 'pec', resolution: quality.textureSize, padding: 2, weld_distance: 0.0002 } },
    '26': { class_type: 'BakeTextureFromVoxel', inputs: { mesh: ['25', 0], voxel_colors: ['23', 0], texture_size: quality.textureSize, reference_mesh: ['20', 0] } },
    '27': { class_type: 'ApplyTextureToMesh', inputs: { mesh: ['25', 0], base_color: ['26', 0], metallic: ['26', 1], roughness: ['26', 2] } },
    '28': { class_type: 'MeshSmoothNormals', inputs: { mesh: ['27', 0], crease_angle: 180 } },
    '29': { class_type: 'RemeshMesh', inputs: { mesh: ['20', 0], resolution: quality.remesh, sign_mode: 'solid', 'sign_mode.fill': 20, 'sign_mode.qef': false, band: 1, project_back: 0, fix_poles: false, smooth_iters: 3, drop_small_components: 0.01, precluster_max_verts: 20000000 } }
  }
  if (quality.shapeDetail > 512) {
    // Refine the 512 shape latent before decoding; texture generation then follows the refined shape.
    workflow['30'] = { class_type: 'Trellis2UpsampleStage', inputs: { positive: ['16', 0], negative: ['16', 1], shape_latent: ['19', 0], vae: ['4', 0], target_resolution: quality.shapeDetail } }
    workflow['31'] = { class_type: 'KSampler', inputs: { model: ['18', 0], positive: ['30', 0], negative: ['30', 1], latent_image: ['30', 2], seed: request.seed, steps: 12, cfg: 7.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } }
    workflow['20'].inputs.samples = ['31', 0]
    workflow['21'].inputs = { positive: ['30', 0], negative: ['30', 1], shape_latent: ['31', 0] }
  }
  return workflow
}
