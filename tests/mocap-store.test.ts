import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Mocap, videoContainer } from '../src/main/mocap'
import { MOCAP_MAX_FRAMES, MOCAP_MODELS, clipFrames, parseCapture, parseCaptureRequest, parseMocapOptions, parseProviderCapture, type MocapCapture } from '../src/shared/mocap'
import type { AiProvenance } from '../src/shared/ai'

const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(124, 1)])
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(116, 2)])
const point = (): [number, number, number, number] => [0.1, -0.2, 0.05, 0.9]
const capture = (frames: MocapCapture['frames']): MocapCapture => ({ version: 1, model: 'lite', fps: 30, width: 640, height: 480, frames })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mocap-store-'))
  const assets = new Map<string, string>()
  let updates = 0
  return { root, assets, updates: () => updates, store: () => new Mocap(root, assets, () => { updates++ }), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('video containers are recognized from their headers', () => {
  assert.equal(videoContainer(webm), 'webm')
  assert.equal(videoContainer(mp4), 'quicktime')
  assert.equal(videoContainer(Buffer.concat([Buffer.alloc(4), Buffer.from('moov')])), 'quicktime')
  assert.equal(videoContainer(Buffer.from('not a video at all')), undefined)
  assert.equal(videoContainer(Buffer.alloc(2)), undefined)
})

test('imported videos must match their extension and are served as private assets', async () => {
  const f = fixture()
  try {
    const mocap = f.store()
    const good = join(f.root, 'walk cycle.mp4'), renamed = join(f.root, 'fake.mp4'), text = join(f.root, 'notes.txt'), tiny = join(f.root, 'tiny.webm')
    writeFileSync(good, mp4); writeFileSync(renamed, webm); writeFileSync(text, mp4); writeFileSync(tiny, webm.subarray(0, 10))
    await assert.rejects(mocap.importVideo(text), /MP4, WebM, MOV/)
    await assert.rejects(mocap.importVideo(renamed), /not a supported/)
    await assert.rejects(mocap.importVideo(tiny), /empty/)
    const take = await mocap.importVideo(good)
    assert.equal(take.name, 'walk cycle')
    assert.equal(take.source, 'file')
    assert.equal(take.bytes, mp4.length)
    assert.equal(take.videoUrl, `studio://asset/${take.id}-video`)
    assert.deepEqual(readFileSync(f.assets.get(`${take.id}-video`)!), mp4)
    assert.equal(mocap.snapshot().takes.length, 1)
    assert.ok(f.updates() > 0)
  } finally { f.cleanup() }
})

test('webcam recordings accept only bounded WebM data', async () => {
  const f = fixture()
  try {
    const mocap = f.store()
    await assert.rejects(mocap.saveRecording(new Uint8Array(mp4)), /WebM/)
    await assert.rejects(mocap.saveRecording(new ArrayBuffer(8)), /empty/)
    await assert.rejects(mocap.saveRecording('video' as unknown as ArrayBuffer), /missing/)
    const view = new Uint8Array(webm.length + 4)
    view.set(webm, 4)
    const take = await mocap.saveRecording(view.subarray(4))
    assert.equal(take.source, 'webcam')
    assert.match(take.videoFile, /\.webm$/)
    assert.deepEqual(readFileSync(f.assets.get(`${take.id}-video`)!), webm)
  } finally { f.cleanup() }
})

test('captures are validated, persisted and survive a restart; deleting removes the take', async () => {
  const f = fixture()
  try {
    const mocap = f.store()
    const path = join(f.root, 'clip.webm')
    writeFileSync(path, webm)
    const take = await mocap.importVideo(path)
    await assert.rejects(mocap.readCapture(take.id), /Capture the pose/)
    await assert.rejects(mocap.saveCapture(take.id, capture([null, null])), /No person/)
    await assert.rejects(mocap.saveCapture(take.id, { ...capture([null, null]), script: 'x' }), /fields/)
    const frames = [Array.from({ length: 33 }, point), null, Array.from({ length: 33 }, point)]
    const saved = await mocap.saveCapture(take.id, capture(frames))
    assert.deepEqual({ frames: saved.capture?.frames, detected: saved.capture?.detected, model: saved.capture?.model }, { frames: 3, detected: 2, model: 'lite' })

    const reloaded = f.store()
    assert.equal(reloaded.snapshot().takes[0].capture?.detected, 2)
    assert.deepEqual((await reloaded.readCapture(take.id)).frames, frames)
    await reloaded.deleteTake(take.id)
    assert.equal(reloaded.snapshot().takes.length, 0)
    assert.equal(f.assets.has(`${take.id}-video`), false)
    assert.equal(existsSync(join(f.root, 'mocap', 'takes', take.id)), false)
    await assert.rejects(reloaded.deleteTake(take.id), /not found/)
  } finally { f.cleanup() }
})

test('takes whose video was removed are dropped on load and models report missing', async () => {
  const f = fixture()
  try {
    const mocap = f.store()
    const path = join(f.root, 'clip.mov')
    writeFileSync(path, mp4)
    const take = await mocap.importVideo(path)
    rmSync(join(f.root, 'mocap', 'takes', take.id, take.videoFile))
    const reloaded = f.store()
    assert.equal(reloaded.snapshot().takes.length, 0)
    assert.deepEqual(reloaded.snapshot().models, { lite: { status: 'missing' }, full: { status: 'missing' } })
    await assert.rejects(reloaded.modelBytes('lite'), /Download/)
  } finally { f.cleanup() }
})

test('a size-matched but tampered pose model is rejected and removed', async () => {
  const f = fixture()
  try {
    const file = join(f.root, 'models', 'mocap', 'pose_landmarker_lite.task')
    mkdirSync(join(f.root, 'models', 'mocap'), { recursive: true })
    writeFileSync(file, Buffer.alloc(MOCAP_MODELS.lite.bytes))
    const reloaded = f.store()
    assert.equal(reloaded.snapshot().models.lite.status, 'ready')
    await assert.rejects(reloaded.modelBytes('lite'), /failed verification/)
    assert.equal(existsSync(file), false)
    assert.equal(reloaded.snapshot().models.lite.status, 'failed')
  } finally { f.cleanup() }
})

test('capture parsing rejects malformed and oversized data', () => {
  const frame = Array.from({ length: 33 }, point)
  assert.equal(parseCapture(capture([frame, null])).frames.length, 2)
  assert.throws(() => parseCapture(capture([frame])))
  assert.throws(() => parseCapture(capture(Array.from({ length: MOCAP_MAX_FRAMES + 1 }, () => null))))
  assert.throws(() => parseCapture(capture([frame.slice(1), null])))
  assert.throws(() => parseCapture(capture([[...frame.slice(1), [Number.NaN, 0, 0, 1]], null])))
  assert.throws(() => parseCapture(capture([[...frame.slice(1), [0, 0, 0, 2]], null])))
  assert.throws(() => parseCapture(capture([[...frame.slice(1), [99, 0, 0, 1]], null])))
  assert.throws(() => parseCapture({ ...capture([frame, null]), fps: 1000 }))
  assert.throws(() => parseCapture({ ...capture([frame, null]), model: 'heavy' }))
  assert.throws(() => parseCapture({ ...capture([frame, null]), version: 2 }))
  assert.deepEqual(parseMocapOptions({ smoothing: 0.25, legs: 'lock', mirror: true, hipHeight: false }), { smoothing: 0.25, legs: 'lock', mirror: true, hipHeight: false })
  assert.throws(() => parseMocapOptions({ smoothing: 2, legs: 'auto', mirror: false, hipHeight: true }))
  assert.throws(() => parseMocapOptions({ smoothing: 0.5, legs: 'fly', mirror: false, hipHeight: true }))
})

test('clip and subject are saved with captures, and provider captures require provenance', async () => {
  const f = fixture()
  try {
    const mocap = f.store()
    const path = join(f.root, 'clip.webm')
    writeFileSync(path, webm)
    const take = await mocap.importVideo(path)
    const frame = Array.from({ length: 33 }, point)
    const saved = await mocap.saveCapture(take.id, { ...capture([frame, frame]), start: 1.5, subject: 'left' })
    assert.deepEqual({ start: saved.capture?.start, subject: saved.capture?.subject }, { start: 1.5, subject: 'left' })
    const provenance: AiProvenance = { stage: 'capture', route: { provider: 'api', location: 'remote', endpoint: 'https://gpu.example', model: 'pose-v1', minVramGB: 0 },
      configurationHash: 'a'.repeat(64), createdAt: new Date().toISOString(), taskId: 'task-1' }
    const remote = { ...capture([frame, frame]), model: 'provider' as const }
    await assert.rejects(mocap.saveCapture(take.id, remote))
    await assert.rejects(mocap.saveCapture(take.id, capture([frame, frame]), provenance))
    const routed = await mocap.saveCapture(take.id, remote, provenance)
    assert.equal(routed.capture?.model, 'provider')
    assert.equal(routed.capture?.provenance?.taskId, 'task-1')
    assert.equal(f.store().snapshot().takes[0].capture?.provenance?.route.model, 'pose-v1')
  } finally { f.cleanup() }
})

test('capture requests and provider outputs are validated against the requested clip', () => {
  const takeId = '2b7c1d7e-3f0a-4d3e-9a7f-0c1b2a3d4e5f'
  assert.deepEqual(parseCaptureRequest({ takeId, start: 1, end: 3, subject: 'right' }), { takeId, start: 1, end: 3, subject: 'right' })
  assert.throws(() => parseCaptureRequest({ takeId, start: 1, end: 3, subject: 'right', script: 'x' }), /Invalid/)
  assert.throws(() => parseCaptureRequest({ takeId: '../x', start: 1, end: 3, subject: 'primary' }), /take/)
  assert.throws(() => parseCaptureRequest({ takeId, start: 2, end: 2, subject: 'primary' }), /after its start/)
  assert.throws(() => parseCaptureRequest({ takeId, start: 0, end: 200, subject: 'primary' }), /at most/)
  assert.throws(() => parseCaptureRequest({ takeId, start: 0, end: 2, subject: 'everyone' }), /subject/)
  assert.equal(clipFrames(1, 3), 61)
  const frame = Array.from({ length: 33 }, point)
  const request = { takeId, start: 1, end: 3, subject: 'left' as const }
  const output = { version: 1, fps: 30, width: 640, height: 480, frames: Array.from({ length: 61 }, () => frame) }
  const parsed = parseProviderCapture(JSON.stringify(output), request)
  assert.deepEqual({ model: parsed.model, start: parsed.start, subject: parsed.subject, frames: parsed.frames.length }, { model: 'provider', start: 1, subject: 'left', frames: 61 })
  assert.equal(parseProviderCapture({ ...output, model: 'lite', start: 9, subject: 'right' }, request).subject, 'left')
  assert.throws(() => parseProviderCapture({ ...output, frames: output.frames.slice(0, 40) }, request), /expected about 61/)
  assert.throws(() => parseProviderCapture([output], request), /expected an object/)
  assert.throws(() => parseProviderCapture({ ...output, frames: output.frames.map(f => f.slice(1)) }, request))
})
