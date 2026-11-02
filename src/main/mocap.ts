import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { downloadVerified } from './download'
import { errorText } from './validation'
import type { AiProvenance } from '../shared/ai'
import {
  MOCAP_MAX_RECORDING_BYTES, MOCAP_MAX_VIDEO_BYTES, MOCAP_MODELS, MOCAP_VIDEO_EXTENSIONS, parseCapture,
  type MocapCapture, type MocapModelState, type MocapPoseModel, type MocapSnapshot, type MocapTake
} from '../shared/mocap'

const QUICKTIME_ATOMS = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'])
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
const models = Object.keys(MOCAP_MODELS) as MocapPoseModel[]

/** Identify a supported video container by its header, regardless of file name. */
export function videoContainer(header: Buffer): 'webm' | 'quicktime' | undefined {
  if (header.length >= 4 && header.subarray(0, 4).equals(WEBM_MAGIC)) return 'webm'
  if (header.length >= 8 && QUICKTIME_ATOMS.has(header.subarray(4, 8).toString('latin1'))) return 'quicktime'
  return undefined
}

export class Mocap {
  private takes: MocapTake[]
  private models: Record<MocapPoseModel, MocapModelState>
  private download?: AbortController
  private readonly directory: string

  constructor(root: string, private readonly assets: Map<string, string>, private readonly notify: () => void) {
    this.directory = join(root, 'mocap')
    mkdirSync(join(this.directory, 'takes'), { recursive: true })
    const file = join(this.directory, 'mocap.json')
    const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { takes?: MocapTake[] } : {}
    this.takes = (stored.takes ?? []).filter(take => /^[0-9a-f-]{36}$/.test(take.id) && existsSync(this.videoPath(take)))
    for (const take of this.takes) take.videoUrl = this.register(take)
    this.models = Object.fromEntries(models.map(model => [model, this.modelReady(model) ? { status: 'ready' } : { status: 'missing' }])) as Record<MocapPoseModel, MocapModelState>
  }

  private modelPath(model: MocapPoseModel) { return join(this.directory, '..', 'models', 'mocap', `pose_landmarker_${model}.task`) }
  private modelReady(model: MocapPoseModel) {
    try { return statSync(this.modelPath(model)).size === MOCAP_MODELS[model].bytes } catch { return false }
  }
  private takeDirectory(id: string) { return join(this.directory, 'takes', id) }
  private videoPath(take: MocapTake) { return join(this.takeDirectory(take.id), take.videoFile) }
  private register(take: MocapTake) {
    this.assets.set(`${take.id}-video`, this.videoPath(take))
    return `studio://asset/${take.id}-video`
  }

  snapshot(): MocapSnapshot {
    return structuredClone({ takes: this.takes, models: this.models })
  }

  private persist() {
    const file = join(this.directory, 'mocap.json')
    writeFileSync(file + '.tmp', JSON.stringify({ takes: this.takes }, null, 2))
    renameSync(file + '.tmp', file)
    this.notify()
  }

  take(id: string): MocapTake {
    const take = this.takes.find(t => t.id === id)
    if (!take) throw new Error('Mocap take not found. Import the video again.')
    return take
  }

  videoFile(id: string) { return this.videoPath(this.take(id)) }

  capturePath(id: string) { return join(this.takeDirectory(this.take(id).id), 'landmarks.json') }

  async readCapture(id: string): Promise<MocapCapture> {
    if (!this.take(id).capture) throw new Error('Capture the pose from this take before exporting.')
    return parseCapture(JSON.parse(await readFile(this.capturePath(id), 'utf8')))
  }

  private async add(source: MocapTake['source'], name: string, extension: string, write: (target: string) => Promise<void>, bytes: number) {
    const take: MocapTake = { id: randomUUID(), name: name.slice(0, 100) || 'Mocap take', createdAt: new Date().toISOString(), source, videoFile: `source.${extension}`, videoUrl: '', bytes }
    mkdirSync(this.takeDirectory(take.id), { recursive: true })
    try { await write(this.videoPath(take)) } catch (error) {
      await rm(this.takeDirectory(take.id), { recursive: true, force: true })
      throw error
    }
    take.videoUrl = this.register(take)
    this.takes.unshift(take)
    this.persist()
    return structuredClone(take)
  }

  async importVideo(path: string): Promise<MocapTake> {
    const extension = extname(path).slice(1).toLowerCase()
    if (!(MOCAP_VIDEO_EXTENSIONS as readonly string[]).includes(extension)) throw new Error('Choose an MP4, WebM, MOV or M4V video.')
    const info = await stat(path)
    if (!info.isFile() || info.size < 64) throw new Error('The selected video is empty.')
    if (info.size > MOCAP_MAX_VIDEO_BYTES) throw new Error('Videos are limited to 1 GB. Trim the take first.')
    const handle = await open(path, 'r')
    const header = Buffer.alloc(16)
    try { await handle.read(header, 0, 16, 0) } finally { await handle.close() }
    const container = videoContainer(header)
    if (!container || (container === 'webm') !== (extension === 'webm')) throw new Error('This file is not a supported MP4/MOV or WebM video.')
    return this.add('file', basename(path, extname(path)), extension, target => copyFile(path, target), info.size)
  }

  async saveRecording(data: ArrayBuffer | ArrayBufferView): Promise<MocapTake> {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('Webcam recording data is missing.')
    const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (bytes.length < 64) throw new Error('The webcam recording is empty.')
    if (bytes.length > MOCAP_MAX_RECORDING_BYTES) throw new Error('Webcam recordings are limited to 256 MB.')
    if (videoContainer(bytes) !== 'webm') throw new Error('Webcam recordings must be WebM video.')
    const name = `Webcam take ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    return this.add('webcam', name, 'webm', target => writeFile(target, bytes), bytes.length)
  }

  async saveCapture(id: string, value: unknown, provenance?: AiProvenance): Promise<MocapTake> {
    const take = this.take(id)
    const capture = parseCapture(value)
    const detected = capture.frames.filter(Boolean).length
    if (!detected) throw new Error('No person was detected in this take. Use a video with one full body in view.')
    if ((capture.model === 'provider') !== !!provenance) throw new Error('Provider captures must be saved with their provider provenance.')
    await writeFile(this.capturePath(id) + '.tmp', JSON.stringify(capture))
    renameSync(this.capturePath(id) + '.tmp', this.capturePath(id))
    take.capture = { model: capture.model, start: capture.start ?? 0, subject: capture.subject ?? 'primary', provenance: provenance && structuredClone(provenance), fps: capture.fps, frames: capture.frames.length, detected, width: capture.width, height: capture.height, capturedAt: new Date().toISOString() }
    this.persist()
    return structuredClone(take)
  }

  async deleteTake(id: string) {
    const take = this.take(id)
    this.takes = this.takes.filter(t => t !== take)
    this.assets.delete(`${take.id}-video`)
    this.persist()
    await rm(this.takeDirectory(take.id), { recursive: true, force: true })
  }

  async downloadModel(model: MocapPoseModel) {
    if (!(model in MOCAP_MODELS)) throw new Error('Unknown pose model.')
    if (this.download) throw new Error('A pose model download is already running.')
    if (this.modelReady(model)) { this.models[model] = { status: 'ready' }; this.notify(); return }
    const spec = MOCAP_MODELS[model]
    const controller = new AbortController()
    this.download = controller
    this.models[model] = { status: 'downloading', progress: 0, message: 'Connecting to Google model storage' }
    this.notify()
    let last = 0
    try {
      mkdirSync(join(this.directory, '..', 'models', 'mocap'), { recursive: true })
      await downloadVerified(spec.url, this.modelPath(model), { sha256: spec.sha256, bytes: spec.bytes }, {
        signal: controller.signal,
        onProgress: ({ received }) => {
          const progress = Math.min(99, Math.round(received / spec.bytes * 100))
          if (progress === last) return
          last = progress
          this.models[model] = { status: 'downloading', progress, message: `${(received / 1024 ** 2).toFixed(1)} of ${(spec.bytes / 1024 ** 2).toFixed(1)} MB` }
          this.notify()
        }
      })
      this.models[model] = { status: 'ready' }
    } catch (error) {
      this.models[model] = { status: controller.signal.aborted ? 'missing' : 'failed', message: controller.signal.aborted ? 'Download cancelled.' : errorText(error) }
      if (!controller.signal.aborted) throw error
    } finally {
      this.download = undefined
      this.notify()
    }
  }

  cancelDownload() { this.download?.abort() }
  dispose() { this.download?.abort() }

  async modelBytes(model: MocapPoseModel): Promise<Uint8Array> {
    if (!(model in MOCAP_MODELS)) throw new Error('Unknown pose model.')
    if (!this.modelReady(model)) throw new Error(`Download ${MOCAP_MODELS[model].label} before capturing.`)
    const bytes = await readFile(this.modelPath(model))
    if (createHash('sha256').update(bytes).digest('hex') !== MOCAP_MODELS[model].sha256) {
      this.models[model] = { status: 'failed', message: 'The saved model failed verification. Download it again.' }
      await rm(this.modelPath(model), { force: true })
      this.notify()
      throw new Error('The saved pose model failed verification. Download it again.')
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
}
