import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { FilesetResolver, PoseLandmarker, type NormalizedLandmark, type PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import {
  ArrowDownToLine, ArrowRight, Bone, Camera, CameraOff, Check, CircleAlert, CircleStop, Clapperboard, Download, Film, LoaderCircle,
  Maximize, Pause, Play, Plus, ScanLine, Send, ShieldCheck, SkipBack, SkipForward, Trash, Video, Volume2, VolumeX, X
} from 'lucide-react'
import type { Character, Snapshot } from '../shared/types'
import { aiModelLabel, resolveAiRoute, type AiStage } from '../shared/ai'
import {
  MOCAP_FPS, MOCAP_MAX_PEOPLE, MOCAP_MAX_RECORDING_BYTES, MOCAP_MAX_SECONDS, MOCAP_MIN_DETECTION, MOCAP_MODELS, MOCAP_RECORD_SECONDS, MOCAP_SUBJECTS,
  POSE_LINKS, POSE_POINTS, clipFrames, defaultMocapOptions, type MocapCapture, type MocapOptions, type MocapPoseModel, type MocapSubject, type PoseFrame
} from '../shared/mocap'
import { AiRouteBadge } from './AiProvidersPanel'
import { ProcessStepper, WorkspaceLayout } from './WorkspaceLayout'
import type { ProcessStep } from '../shared/workspace'
import { PoseSkeleton, poseFloor } from './PoseSkeleton'
import { Viewport } from './Viewport'
import './mocap.css'

interface Props {
  snapshot: Snapshot
  visible: boolean
  animatorBusy: boolean
  onReviewFit: (character: Character) => void
  onProviders: (stage: AiStage) => void
  onOpenAnimator: (character: Character, jobId: string) => void
}
type Step = 1 | 2 | 3 | 4
interface Clip { start: number; end: number }

const done = new Set(['complete', 'failed', 'cancelled'])
const models = Object.keys(MOCAP_MODELS) as MocapPoseModel[]
const subjects = Object.keys(MOCAP_SUBJECTS) as MocapSubject[]
const steps: { id: string; label: string; kicker: string; detail: string }[] = [
  { id: 'video', label: 'Import video', kicker: '01 / CHOOSE A PERFORMANCE', detail: 'Import a reference video or record one with your webcam.' },
  { id: 'capture', label: 'Capture motion', kicker: '02 / CAPTURE THE MOTION', detail: 'Set the clip range and subject, then capture motion on this PC.' },
  { id: 'review', label: 'Review', kicker: '03 / CHECK THE CAPTURE', detail: 'Play the clip and check the skeleton before applying it to a character.' },
  { id: 'send', label: 'Send to Animator', kicker: '04 / APPLY TO A CHARACTER', detail: 'Choose a rigged T-pose character, then export the motion to Animator.' }
]
const THUMBNAILS = 6
const frameTime = 1 / MOCAP_FPS
const explain = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')
const round = (value: number) => Math.round(value * 1e4) / 1e4
const visibility = (value: number | undefined) => Number.isFinite(value) ? Math.min(1, Math.max(0, value!)) : 0
const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(bytes < 100 * 1024 ** 2 ? 1 : 0)} MB`
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
/** mm:ss.s, used for clip fields and the timeline. */
export function clock(seconds: number) {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${(safe - minutes * 60).toFixed(1).padStart(4, '0')}`
}
/** Accepts mm:ss(.s) or plain seconds. */
export function parseClock(text: string) {
  const match = /^\s*(?:(\d{1,3}):)?(\d{1,4}(?:\.\d+)?)\s*$/.exec(text)
  if (!match || (match[1] !== undefined && Number(match[2]) >= 60)) return NaN
  return (match[1] ? Number(match[1]) * 60 : 0) + Number(match[2])
}

function outputLabel(file: string) {
  if (file === 'mocap-motion.json') return 'Solved bone motion · JSON'
  if (file === 'landmarks.json') return 'Captured pose landmarks · JSON'
  const extension = file.split('.').pop()!
  return `Animated character · ${extension === 'blend' ? 'Blender' : extension.toUpperCase()}`
}

function abortError() { return new DOMException('Pose capture cancelled.', 'AbortError') }

/** Resolve on the first listed event, rejecting on media errors, aborts and stalls. */
function waitFor(video: HTMLVideoElement, events: string[], signal: AbortSignal, timeout: number, start: () => void) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer)
      for (const event of events) video.removeEventListener(event, ok)
      video.removeEventListener('error', failed)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error); else resolve()
    }
    const ok = () => finish()
    const failed = () => finish(new Error('This video could not be decoded. Re-encode it as H.264 MP4 or VP8/VP9 WebM and import it again.'))
    const aborted = () => finish(abortError())
    const timer = setTimeout(() => finish(new Error('The video stopped responding while reading frames. Re-encode it as H.264 MP4 and import it again.')), timeout)
    for (const event of events) video.addEventListener(event, ok)
    video.addEventListener('error', failed)
    signal.addEventListener('abort', aborted)
    if (signal.aborted) aborted()
    else start()
  })
}

async function videoReady(video: HTMLVideoElement, signal: AbortSignal) {
  if (video.error) throw new Error('This video could not be decoded. Re-encode it as H.264 MP4 or VP8/VP9 WebM and import it again.')
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return
  await waitFor(video, ['loadeddata'], signal, 30_000, () => { if (video.networkState === HTMLMediaElement.NETWORK_EMPTY) video.load() })
}

async function videoDuration(video: HTMLVideoElement, signal: AbortSignal) {
  // MediaRecorder WebM files have no duration header; seeking past the end makes the browser scan for it.
  if (!Number.isFinite(video.duration)) await waitFor(video, ['durationchange', 'seeked'], signal, 60_000, () => { video.currentTime = 1e7 })
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('Could not read this video\'s length. Re-encode it as H.264 MP4 and import it again.')
  return video.duration
}

const seek = (video: HTMLVideoElement, time: number, signal: AbortSignal) => waitFor(video, ['seeked'], signal, 15_000, () => { video.currentTime = time })

/** Choose the requested performer when several people are tracked: by mean hip position in the image. */
function choosePose(result: PoseLandmarkerResult, subject: MocapSubject) {
  if (subject === 'primary' || result.landmarks.length < 2) return result.landmarks.length ? 0 : -1
  const hips = result.landmarks.map(points => ((points[23]?.x ?? 0.5) + (points[24]?.x ?? 0.5)) / 2)
  let best = 0
  for (let i = 1; i < hips.length; i++) if (subject === 'left' ? hips[i] < hips[best] : hips[i] > hips[best]) best = i
  return best
}

/** Mirrors the video element's playback state into React without re-rendering the whole panel. */
function useVideoClock(videoRef: RefObject<HTMLVideoElement | null>, enabled: boolean) {
  const [state, setState] = useState({ time: 0, playing: false, muted: false, volume: 1 })
  useEffect(() => {
    const video = videoRef.current
    if (!video || !enabled) return
    let frame = 0
    const read = () => setState({ time: video.currentTime, playing: !video.paused && !video.ended, muted: video.muted, volume: video.volume })
    const tick = () => { read(); if (!video.paused) frame = requestAnimationFrame(tick) }
    const play = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick) }
    const events = ['pause', 'seeked', 'timeupdate', 'volumechange', 'loadedmetadata', 'ended']
    for (const event of events) video.addEventListener(event, read)
    video.addEventListener('play', play)
    read()
    return () => {
      cancelAnimationFrame(frame)
      for (const event of events) video.removeEventListener(event, read)
      video.removeEventListener('play', play)
    }
  }, [enabled])
  return state
}

function SourceControls({ videoRef, frameRef, duration, disabled, clipLoop }: {
  videoRef: RefObject<HTMLVideoElement | null>; frameRef: RefObject<HTMLDivElement | null>; duration: number; disabled: boolean; clipLoop: RefObject<boolean>
}) {
  const { time, playing, muted } = useVideoClock(videoRef, true)
  const video = videoRef.current
  return <div className="mocap-source-controls">
    <button className="icon-button" aria-label={playing ? 'Pause source video' : 'Play source video'} disabled={disabled || !duration}
      onClick={() => { if (!video) return; clipLoop.current = false; if (playing) video.pause(); else void video.play().catch(() => undefined) }}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
    <span className="mocap-time">{clock(time)}</span>
    <input type="range" aria-label="Source video position" min={0} max={duration || 0} step={frameTime} value={Math.min(time, duration || 0)} disabled={disabled || !duration}
      onChange={event => { if (video) video.currentTime = Number(event.target.value) }} />
    <span className="mocap-time">{clock(duration)}</span>
    <button className="icon-button" aria-label={muted ? 'Unmute source video' : 'Mute source video'} aria-pressed={muted} disabled={!duration}
      onClick={() => { if (video) video.muted = !video.muted }}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
    <button className="icon-button" aria-label="Fullscreen source video" disabled={!duration}
      onClick={() => void frameRef.current?.requestFullscreen().catch(() => undefined)}><Maximize size={15} /></button>
  </div>
}

function Timeline({ videoRef, duration, clip, onClip, thumbnails, disabled, clipLoop }: {
  videoRef: RefObject<HTMLVideoElement | null>; duration: number; clip: Clip; onClip: (clip: Clip) => void; thumbnails: string[]; disabled: boolean; clipLoop: RefObject<boolean>
}) {
  const { time, playing, volume, muted } = useVideoClock(videoRef, true)
  const track = useRef<HTMLDivElement>(null)
  const video = videoRef.current
  const percent = (value: number) => `${duration ? clamp(value / duration, 0, 1) * 100 : 0}%`
  const looping = playing && clipLoop.current
  useEffect(() => {
    if (!video || !looping) return
    let frame = 0
    const check = () => {
      if (video.currentTime >= clip.end - 1e-3 || video.currentTime < clip.start - 0.05) video.currentTime = clip.start
      frame = requestAnimationFrame(check)
    }
    frame = requestAnimationFrame(check)
    return () => cancelAnimationFrame(frame)
  }, [looping, clip.start, clip.end])
  const at = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect()
    return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * duration
  }
  const setEdge = (edge: 'start' | 'end', value: number) => {
    if (edge === 'start') onClip({ start: clamp(value, Math.max(0, clip.end - MOCAP_MAX_SECONDS), clip.end - 2 * frameTime), end: clip.end })
    else onClip({ start: clip.start, end: clamp(value, clip.start + 2 * frameTime, Math.min(duration, clip.start + MOCAP_MAX_SECONDS)) })
  }
  const handleProps = (edge: 'start' | 'end') => ({
    role: 'slider', tabIndex: disabled ? -1 : 0, 'aria-disabled': disabled,
    'aria-label': edge === 'start' ? 'Clip in point' : 'Clip out point', 'aria-valuemin': 0, 'aria-valuemax': Math.round(duration * 10) / 10,
    'aria-valuenow': Math.round(clip[edge] * 10) / 10, 'aria-valuetext': clock(clip[edge]),
    className: `mocap-handle ${edge}`, style: { left: percent(clip[edge]) },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => { if (disabled) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId) },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setEdge(edge, at(event.clientX)) },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return
      const step = event.shiftKey ? 1 : frameTime
      const next = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? clip[edge] - step : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? clip[edge] + step :
        event.key === 'Home' ? 0 : event.key === 'End' ? duration : undefined
      if (next === undefined) return
      event.preventDefault()
      setEdge(edge, next)
    }
  })
  const step = (delta: number) => { if (!video) return; video.pause(); video.currentTime = clamp(video.currentTime + delta, 0, duration) }
  return <section className="mocap-timeline" aria-label="Clip timeline">
    <div className="mocap-timeline-bar">
      <button className="icon-button lime" aria-label={looping ? 'Pause clip' : 'Play clip'} disabled={disabled || !duration} onClick={() => {
        if (!video) return
        if (looping) { video.pause(); return }
        clipLoop.current = true
        if (video.currentTime < clip.start || video.currentTime >= clip.end - 1e-3) video.currentTime = clip.start
        void video.play().catch(() => undefined)
      }}>{looping ? <Pause size={15} /> : <Play size={15} />}</button>
      <span className="mocap-time strong">{clock(time)} <small>/ {clock(duration)}</small></span>
      <span className="mocap-clip-length">Clip {clock(clip.start)} – {clock(clip.end)} · {(clip.end - clip.start).toFixed(1)}s</span>
      <span className="mocap-timeline-spacer" />
      <button className="icon-button" aria-label="Previous frame" disabled={disabled || !duration} onClick={() => step(-frameTime)}><SkipBack size={14} /></button>
      <button className="icon-button" aria-label="Next frame" disabled={disabled || !duration} onClick={() => step(frameTime)}><SkipForward size={14} /></button>
      <span className="mocap-volume">{muted || !volume ? <VolumeX size={14} /> : <Volume2 size={14} />}
        <input type="range" aria-label="Volume" min={0} max={1} step={0.05} value={muted ? 0 : volume} disabled={!duration}
          onChange={event => { if (!video) return; video.volume = Number(event.target.value); video.muted = video.volume === 0 }} /></span>
    </div>
    <div ref={track} className={`mocap-track ${disabled ? 'disabled' : ''}`} role="slider" tabIndex={disabled ? -1 : 0} aria-label="Timeline position"
      aria-valuemin={0} aria-valuemax={Math.round(duration * 10) / 10} aria-valuenow={Math.round(time * 10) / 10} aria-valuetext={clock(time)} aria-disabled={disabled}
      onPointerDown={event => { if (!disabled && video && duration) { video.pause(); video.currentTime = at(event.clientX) } }}
      onKeyDown={event => {
        if (disabled || !video) return
        const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
        if (!delta) return
        event.preventDefault()
        step(delta * (event.shiftKey ? 1 : frameTime))
      }}>
      <div className="mocap-filmstrip" aria-hidden="true">
        {Array.from({ length: THUMBNAILS }, (_, i) => thumbnails[i] ? <img key={i} src={thumbnails[i]} alt="" draggable={false} /> : <span key={i} />)}
      </div>
      <div className="mocap-outside" style={{ left: 0, width: percent(clip.start) }} />
      <div className="mocap-outside" style={{ left: percent(clip.end), right: 0 }} />
      <div className="mocap-range" style={{ left: percent(clip.start), width: `calc(${percent(clip.end)} - ${percent(clip.start)})` }} />
      <div className="mocap-playhead" style={{ left: percent(time) }} />
      <div {...handleProps('start')}><span>In</span></div>
      <div {...handleProps('end')}><span>Out</span></div>
    </div>
    <div className="mocap-ruler" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i}>{clock(duration * i / 4)}</span>)}</div>
  </section>
}

export function MocapPanel({ snapshot, visible, animatorBusy, onReviewFit, onProviders, onOpenAnimator }: Props) {
  const data = snapshot.mocap
  const [characterId, setCharacterId] = useState('')
  const [takeId, setTakeId] = useState('')
  const [model, setModel] = useState<MocapPoseModel>('lite')
  const [subject, setSubject] = useState<MocapSubject>('primary')
  const [options, setOptions] = useState<MocapOptions>(defaultMocapOptions)
  const [view, setView] = useState<'character' | 'animation'>('character')
  const [resultId, setResultId] = useState('')
  const [step, setStep] = useState<Step>(1)
  const [clip, setClip] = useState<Clip>({ start: 0, end: 0 })
  const [clipText, setClipText] = useState({ start: '', end: '' })
  const [duration, setDuration] = useState(0)
  const [thumbnails, setThumbnails] = useState<string[]>([])
  const [captureData, setCaptureData] = useState<MocapCapture>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState<{ frame: number; total: number; detected: number }>()
  const [camera, setCamera] = useState<MediaStream>()
  const [countdown, setCountdown] = useState(0)
  const [recording, setRecording] = useState<number>()
  const [confirmDelete, setConfirmDelete] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const thumbRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const liveFrame = useRef<PoseFrame>(null)
  const clipLoop = useRef(false)
  const clipFor = useRef('')
  const captureAbort = useRef<AbortController>(undefined)
  const cameraRef = useRef<MediaStream>(undefined)
  const recorderRef = useRef<{ recorder: MediaRecorder; discard: boolean }>(undefined)
  const timers = useRef<number[]>([])

  const character = snapshot.characters.find(c => c.id === characterId)
  const take = data?.takes.find(t => t.id === takeId)
  const captured = take?.capture
  const route = resolveAiRoute(snapshot.ai, 'capture')
  const remote = route.provider !== 'builtin'
  const results = snapshot.jobs.filter(j => j.kind === 'mocap' && j.characterId === characterId)
  const result = results.find(j => j.id === resultId && j.stage === 'complete')
  const active = snapshot.jobs.find(j => !done.has(j.stage))
  const systemBusy = animatorBusy || !!active || snapshot.batches.some(b => b.status === 'running') ||
    !!snapshot.designer?.designs.some(d => d.status === 'running') || snapshot.designer?.modelDownload?.status === 'running'
  const capturing = !!progress
  const locked = busy || systemBusy || capturing || !!camera
  const modelState = data?.models[model]
  const downloading = models.find(id => data?.models[id].status === 'downloading')
  const url = view === 'animation' ? result?.previewUrl : character?.rigged ? character.rigPreviewUrl : character?.previewUrl
  const sent = !!take && snapshot.jobs.some(j => j.kind === 'mocap' && j.stage === 'complete' && j.mocapTakeId === take.id)
  const clipValid = !!take && duration > 0 && clip.end - clip.start >= 2 * frameTime && clip.end <= duration + 0.05 && clip.end - clip.start <= MOCAP_MAX_SECONDS + 0.05
  const processSteps: ProcessStep[] = [
    { id: 'video', label: 'Import video', complete: !!take, state: camera ? 'running' : undefined },
    { id: 'capture', label: 'Capture motion', complete: !!captured, state: capturing || active?.kind === 'capture' ? 'running' : !take ? 'blocked' : undefined },
    { id: 'review', label: 'Review', complete: !!captured && (step === 4 || sent), state: !captured ? 'blocked' : undefined },
    { id: 'send', label: 'Send to Animator', complete: sent,
      state: active?.kind === 'mocap' && active.characterId === characterId ? 'running' : results[0]?.stage === 'failed' ? 'failed' : !captured ? 'blocked' : undefined }
  ]
  const captureKey = take && captured ? `${take.id}:${captured.model}:${captured.start}:${captured.frames}:${captured.detected}` : ''
  const extension = take?.videoFile.split('.').pop()?.toUpperCase() ?? ''

  useEffect(() => {
    if (!snapshot.characters.some(c => c.id === characterId))
      setCharacterId(snapshot.characters.find(c => c.rigged)?.id ?? snapshot.characters[0]?.id ?? '')
    if (data && !data.takes.some(t => t.id === takeId)) setTakeId(data.takes[0]?.id ?? '')
  }, [snapshot])
  useEffect(() => {
    setConfirmDelete(''); clearOverlay(); setDuration(0); setThumbnails([])
    clipLoop.current = false
    setStep(!take ? 1 : take.capture ? 3 : 2)
  }, [take?.id])
  useEffect(() => {
    setCaptureData(undefined)
    if (!captureKey || !take) return
    let current = true
    window.studio.mocapReadCapture(take.id).then(value => { if (current) setCaptureData(value) }, e => { if (current) setError(explain(e)) })
    return () => { current = false }
  }, [captureKey])
  // Probe the length and draw the filmstrip from a hidden copy so the visible video is never disturbed.
  useEffect(() => {
    const video = thumbRef.current
    if (!take || !video || !visible) return
    const controller = new AbortController()
    const { signal } = controller
    void (async () => {
      await videoReady(video, signal)
      const length = await videoDuration(video, signal)
      setDuration(length)
      const canvas = document.createElement('canvas')
      canvas.height = 72
      canvas.width = Math.max(32, Math.round(72 * (video.videoWidth || 16) / (video.videoHeight || 9)))
      const context = canvas.getContext('2d')!
      const images: string[] = []
      for (let i = 0; i < THUMBNAILS; i++) {
        await seek(video, Math.min(length * (i + 0.5) / THUMBNAILS, Math.max(0, length - 0.05)), signal)
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        images.push(canvas.toDataURL('image/jpeg', 0.7))
        setThumbnails([...images])
      }
    })().catch(e => { if (!signal.aborted) setError(explain(e)) })
    return () => controller.abort()
  }, [take?.videoUrl, visible])
  useEffect(() => {
    if (!take || !duration || clipFor.current === take.id) return
    clipFor.current = take.id
    changeClip(captured ? { start: captured.start ?? 0, end: Math.min(duration, (captured.start ?? 0) + (captured.frames - 1) / captured.fps) } : { start: 0, end: Math.min(duration, MOCAP_MAX_SECONDS) })
  }, [take?.id, duration])
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = camera ?? null
    if (camera) void video.play().catch(() => undefined)
  }, [camera])
  useEffect(() => { if (step === 4 && !capturing) videoRef.current?.pause() }, [step])
  useEffect(() => { if (!visible) { closeCamera(); videoRef.current?.pause() } }, [visible])
  useEffect(() => () => { captureAbort.current?.abort(); closeCamera() }, [])

  async function perform(action: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }
  function changeClip(next: Clip) {
    setClip(next)
    setClipText({ start: clock(next.start), end: clock(next.end) })
  }
  function commitClip(edge: 'start' | 'end') {
    const value = parseClock(clipText[edge])
    const next = { ...clip, [edge]: value }
    const problem = !Number.isFinite(value) ? 'Enter a time as mm:ss.s or seconds.' :
      next.start < 0 || next.end > duration + 0.05 ? `The clip must stay within the video (00:00.0 – ${clock(duration)}).` :
        next.end - next.start < 2 * frameTime ? 'The clip end must be after its start.' :
          next.end - next.start > MOCAP_MAX_SECONDS + 0.05 ? `Capture at most ${MOCAP_MAX_SECONDS / 60} minutes at a time.` : ''
    if (problem) { setError(problem); changeClip(clip); return }
    setError('')
    changeClip({ start: next.start, end: Math.min(next.end, duration) })
    if (videoRef.current && edge === 'start') videoRef.current.currentTime = next.start
  }
  function selectTake(id: string) {
    clipFor.current = ''
    setTakeId(id)
  }
  function selectCharacter(c: Character) {
    setCharacterId(c.id); setView('character'); setResultId('')
  }
  function clearOverlay() {
    const canvas = overlayRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }
  function drawPose(points: NormalizedLandmark[] | undefined, width: number, height: number) {
    const canvas = overlayRef.current
    if (!canvas) return
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, width, height)
    if (!points) return
    context.lineWidth = Math.max(2, width / 300)
    context.strokeStyle = '#c8f06a'
    context.fillStyle = '#f2ffd9'
    context.beginPath()
    for (const [a, b] of POSE_LINKS) {
      context.moveTo(points[a].x * width, points[a].y * height)
      context.lineTo(points[b].x * width, points[b].y * height)
    }
    context.stroke()
    for (const point of points.slice(11)) {
      context.beginPath()
      context.arc(point.x * width, point.y * height, context.lineWidth * 1.4, 0, Math.PI * 2)
      context.fill()
    }
  }
  /** Pose shown in Motion preview: live during capture, otherwise the saved capture at the video's current time. */
  function previewFrame(): PoseFrame | undefined {
    if (liveFrame.current) return liveFrame.current
    const video = videoRef.current
    if (!captureData || !video) return undefined
    const index = Math.round((video.currentTime - (captureData.start ?? 0)) * captureData.fps)
    return index >= 0 && index < captureData.frames.length ? captureData.frames[index] ?? undefined : undefined
  }
  function loopFrame(): PoseFrame | undefined {
    if (!captureData) return undefined
    return captureData.frames[Math.floor(performance.now() / 1000 * captureData.fps) % captureData.frames.length] ?? undefined
  }

  async function capture() {
    if (!take || !clipValid) return
    if (remote) {
      await perform(async () => {
        await window.studio.mocapCapture({ takeId: take.id, start: clip.start, end: clip.end, subject })
        setStep(3)
        setNotice('The capture provider returned valid pose landmarks. Review the motion, then send it to Animator.')
      })
      return
    }
    const video = videoRef.current
    if (!video) return
    const controller = new AbortController()
    captureAbort.current = controller
    const signal = controller.signal
    clipLoop.current = false
    setError(''); setNotice(''); setProgress({ frame: 0, total: 0, detected: 0 })
    let landmarker: PoseLandmarker | undefined
    try {
      video.pause()
      const asset = await window.studio.mocapModel(model)
      signal.throwIfAborted()
      const vision = await FilesetResolver.forVisionTasks('studio://mocap-runtime')
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: asset, delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: subject === 'primary' ? 1 : MOCAP_MAX_PEOPLE,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5
      })
      await videoReady(video, signal)
      const length = await videoDuration(video, signal)
      if (clip.end > length + 0.05) throw new Error('The clip range extends past the end of this video. Adjust the clip and try again.')
      const total = clipFrames(clip.start, clip.end)
      const frames: PoseFrame[] = []
      let detected = 0
      for (let i = 0; i < total; i++) {
        await seek(video, Math.min(clip.start + i * frameTime, Math.max(0, length - 0.001)), signal)
        const pose = landmarker.detectForVideo(video, i * 1000 / MOCAP_FPS)
        const chosen = choosePose(pose, subject)
        const world = pose.worldLandmarks[chosen], image = pose.landmarks[chosen]
        if (chosen >= 0 && world?.length === POSE_POINTS) {
          const frame = world.map((p, k) => [round(p.x), round(p.y), round(p.z), round(visibility(p.visibility ?? image?.[k]?.visibility))] as [number, number, number, number])
          frames.push(frame)
          liveFrame.current = frame
          detected++
        } else frames.push(null)
        drawPose(image, video.videoWidth, video.videoHeight)
        if (i % 3 === 0 || i === total - 1) setProgress({ frame: i + 1, total, detected })
      }
      signal.throwIfAborted()
      if (detected / total < MOCAP_MIN_DETECTION)
        throw new Error(`A person was detected in only ${detected} of ${total} frames. Use a well-lit video with one person whose full body stays in view, then capture again. No capture was saved.`)
      await window.studio.mocapSaveCapture(take.id, { version: 1, model, fps: MOCAP_FPS, width: video.videoWidth, height: video.videoHeight, frames, start: round(clip.start), subject })
      video.currentTime = clip.start
      setStep(3)
      setNotice(`Motion captured: a person was detected in ${detected} of ${total} frames. Review it, then send it to Animator.`)
    } catch (e) {
      setError(signal.aborted ? 'Pose capture cancelled. No capture was saved.' : explain(e))
    } finally {
      landmarker?.close()
      liveFrame.current = null
      captureAbort.current = undefined
      clearOverlay()
      setProgress(undefined)
    }
  }

  function clearTimers() {
    for (const timer of timers.current) window.clearInterval(timer)
    timers.current = []
    setCountdown(0)
  }
  function closeCamera() {
    clearTimers()
    if (recorderRef.current) {
      recorderRef.current.discard = true
      if (recorderRef.current.recorder.state !== 'inactive') recorderRef.current.recorder.stop()
      recorderRef.current = undefined
    }
    setRecording(undefined)
    for (const track of cameraRef.current?.getTracks() ?? []) track.stop()
    cameraRef.current = undefined
    setCamera(undefined)
  }
  async function openCamera() {
    setError(''); setNotice('')
    if (!navigator.mediaDevices?.getUserMedia) { setError('Camera capture is unavailable in this window.'); return }
    try {
      videoRef.current?.pause()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } })
      cameraRef.current = stream
      setCamera(stream)
      setStep(1)
      clearOverlay()
      setNotice('Camera preview is live and stays on this PC. Step back until your whole body is in frame, then record.')
    } catch (e) {
      setError(`Could not open a camera: ${explain(e)} Check that a webcam is connected, not in use by another app, and allowed for desktop apps in Windows camera privacy settings.`)
    }
  }
  function startRecording() {
    const stream = cameraRef.current
    if (!stream) return
    setError(''); setNotice('')
    let remaining = 3
    setCountdown(remaining)
    const timer = window.setInterval(() => {
      remaining -= 1
      setCountdown(remaining)
      if (remaining > 0) return
      clearTimers()
      try { beginRecording(stream) } catch (e) { setError(`Could not start recording: ${explain(e)}`) }
    }, 1000)
    timers.current.push(timer)
  }
  function beginRecording(stream: MediaStream) {
    const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
    const state = { recorder, discard: false }
    const chunks: Blob[] = []
    let size = 0
    recorder.ondataavailable = event => {
      if (!event.data.size) return
      chunks.push(event.data)
      size += event.data.size
      if (size > MOCAP_MAX_RECORDING_BYTES && recorder.state === 'recording') { state.discard = true; recorder.stop(); setError('The recording exceeded 256 MB and was discarded. Record a shorter take.') }
    }
    recorder.onstop = () => {
      if (state.discard) return
      const blob = new Blob(chunks, { type: 'video/webm' })
      closeCamera()
      void perform(async () => {
        const saved = await window.studio.mocapSaveRecording(await blob.arrayBuffer())
        selectTake(saved.id)
        setNotice('Webcam take saved on this PC. Set the clip range, then capture motion.')
      })
    }
    recorderRef.current = state
    recorder.start(1000)
    const started = performance.now()
    setRecording(0)
    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - started) / 1000
      setRecording(elapsed)
      if (elapsed >= MOCAP_RECORD_SECONDS) stopRecording()
    }, 250)
    timers.current.push(timer)
  }
  function stopRecording() {
    clearTimers()
    const current = recorderRef.current
    recorderRef.current = undefined
    setRecording(undefined)
    if (current && current.recorder.state !== 'inactive') current.recorder.stop()
  }

  async function sendToAnimator() {
    if (!character || !take) return
    await perform(async () => {
      await window.studio.mocapExport({ takeId: take.id, characterId: character.id, options })
      const latest = (await window.studio.snapshot()).jobs.find(j => j.kind === 'mocap' && j.characterId === character.id && j.mocapTakeId === take.id && j.stage === 'complete')
      if (!latest) throw new Error('The mocap export finished without a completed result. Nothing was sent to Animator.')
      setResultId(latest.id); setView('animation')
      setNotice('Animated character exported, validated and sent to Animator. Review it before production use: monocular capture estimates depth, contacts and hidden limbs.')
      onOpenAnimator(character, latest.id)
    })
  }
  const importVideo = () => void perform(async () => {
    const t = await window.studio.mocapImportVideo()
    if (t) { selectTake(t.id); setNotice('Video imported. Set the clip range and subject, then capture motion.') }
  })

  const selectStep = (id: string) => { const index = steps.findIndex(item => item.id === id); if (index >= 0) setStep(index + 1 as Step) }
  const heading = steps[step - 1]
  const reason = !captured ? 'Capture motion first.' : !character ? 'Import a T-pose character first.' : !character.rigged ? 'Build the skin and rig first.' : ''
  return <WorkspaceLayout id="mocap-panel" labelledBy="mocap-tab" hidden={!visible} step={heading.id} className="mocap-layout">
    <aside className="workflow-settings mocap-settings" aria-label="Mocap step settings">
      <div className="section-kicker">{heading.kicker}</div>
      <h1>{heading.label}</h1>
      <p className="panel-description">{heading.detail}</p>

      {step < 4 && <div className="mocap-card">
        {take ? <>
          <span className="mocap-card-icon">{take.source === 'webcam' ? <Camera size={18} /> : <Film size={18} />}</span>
          <span className="mocap-card-text"><strong title={take.name}>{take.name}</strong><small>{extension} · {duration ? clock(duration).replace(/\.\d$/, '') : '--:--'} · {megabytes(take.bytes)}</small></span>
          <button className="text-button" disabled={locked} onClick={importVideo}>Change video</button>
        </> : <>
          <span className="mocap-card-icon"><Film size={18} /></span>
          <span className="mocap-card-text"><strong>No reference video</strong><small>MP4, MOV or WebM · one person, full body</small></span>
        </>}
      </div>}

      {step === 1 && <>
        {!take && <button className="primary full" disabled={locked} onClick={importVideo}><Video size={15} /> Import video file</button>}
        <button className="secondary full" disabled={locked} onClick={() => void openCamera()}><Camera size={15} /> Record with webcam</button>
        <p className="fine-print">Best results: one person, front-facing, whole body in frame, steady camera and good light. Up to {MOCAP_MAX_SECONDS / 60} minutes are captured per clip.</p>
        {take && !camera && <button className="primary full" disabled={locked} onClick={() => setStep(2)}>Continue to clip and capture <ArrowRight size={15} /></button>}
      </>}

      {step === 2 && <>
        {take ? <>
          <span className="field-label">Clip range</span>
          <div className="mocap-clip-fields">
            <label><small>Start</small><input aria-label="Clip start" value={clipText.start} disabled={locked || !duration} placeholder="00:00.0"
              onChange={e => setClipText({ ...clipText, start: e.target.value })} onBlur={() => commitClip('start')} onKeyDown={e => { if (e.key === 'Enter') commitClip('start') }} /></label>
            <span className="mocap-clip-dash">–</span>
            <label><small>End</small><input aria-label="Clip end" value={clipText.end} disabled={locked || !duration} placeholder="00:00.0"
              onChange={e => setClipText({ ...clipText, end: e.target.value })} onBlur={() => commitClip('end')} onKeyDown={e => { if (e.key === 'Enter') commitClip('end') }} /></label>
          </div>
          <p className="fine-print">Drag the In and Out handles on the timeline or type times as mm:ss.s.</p>
        </> : <p className="fine-print">Import or record a video in step 1 first.</p>}
        <label className="field-label" htmlFor="mocap-subject">Subject</label>
        <select id="mocap-subject" aria-label="Subject" disabled={locked} value={subject} onChange={e => setSubject(e.target.value as MocapSubject)}>
          {subjects.map(id => <option key={id} value={id}>{MOCAP_SUBJECTS[id]}</option>)}
        </select>
        <details className="model-advanced mocap-options">
          <summary>Capture options</summary>
          {remote ? <p className="fine-print">This provider uses <strong>{aiModelLabel(route) || 'its configured model'}</strong> through a mapped {route.provider === 'api' ? 'Studio API gateway' : 'ComfyUI'} workflow. Change it in Model Settings.</p> : <>
            <div className="mocap-models" role="radiogroup" aria-label="Pose model">
              {models.map(id => {
                const state = data?.models[id]
                const spec = MOCAP_MODELS[id]
                return <div key={id} className={`mocap-model ${model === id ? 'selected' : ''}`}>
                  <label><input type="radio" name="mocap-model" aria-label={`Use ${spec.label}`} checked={model === id} disabled={capturing} onChange={() => setModel(id)} /><span><strong>{spec.label}</strong><small>{spec.detail} {megabytes(spec.bytes)}.</small>
                    <small className={state?.status === 'failed' ? 'failure-text' : ''} aria-label={`${spec.label} status`}>{state?.status === 'ready' ? 'Downloaded and verified' : state?.status === 'downloading' ? `Downloading ${state.progress ?? 0}% · ${state.message ?? ''}` : state?.message ?? 'Not downloaded'}</small></span></label>
                  {state?.status !== 'ready' && state?.status !== 'downloading' && <button className="secondary" aria-label={`Download ${spec.label}`} disabled={!!downloading} onClick={() => { setError(''); void window.studio.mocapDownloadModel(id).catch(e => setError(explain(e))) }}><Download size={14} /> Download</button>}
                  {state?.status === 'downloading' && <button className="secondary" aria-label={`Cancel ${spec.label} download`} onClick={() => void window.studio.mocapCancelDownload()}>Cancel</button>}
                </div>
              })}
            </div>
            <p className="fine-print">MediaPipe Pose runs on the CPU in this window at {MOCAP_FPS} fps; no GPU is required. Models download from Google's MediaPipe storage (Apache-2.0) and are checked against a pinned SHA-256.</p>
          </>}
        </details>
        <div className="ai-stage-routes" role="group" aria-label="Current step models"><AiRouteBadge snapshot={snapshot} stage="capture" onClick={() => onProviders('capture')} /></div>
        <button className="primary full" disabled={locked || !take || !clipValid || (!remote && modelState?.status !== 'ready')} onClick={() => void capture()}>
          <ScanLine size={16} /> {captured ? 'Capture again' : 'Start capture'}</button>
        {!remote && take && modelState?.status !== 'ready' && <p className="fine-print">Download {MOCAP_MODELS[model].label} under Capture options first.</p>}
        {captured && <p className="fine-print">Capturing again replaces this take's saved capture. Exported characters are kept.</p>}
      </>}

      {step === 3 && (captured ? <>
        <p className="fine-print" aria-label="Capture summary">{captured.model === 'provider' ? `Captured by ${aiModelLabel(captured.provenance?.route ?? route) || 'the capture provider'}` : `Captured with ${MOCAP_MODELS[captured.model].label}`} · {MOCAP_SUBJECTS[captured.subject ?? 'primary']} · {clock(captured.start ?? 0)} + {((captured.frames - 1) / captured.fps).toFixed(1)}s · person found in {captured.detected} of {captured.frames} frames.</p>
        <ul className="mocap-checklist">
          <li>Play the clip: the skeleton follows the source video.</li>
          <li>Check limbs that leave the frame or hide behind the body.</li>
          <li>Depth, foot contact and travel are estimated from one camera.</li>
        </ul>
        <button className="primary full" disabled={locked} onClick={() => setStep(4)}>Continue to Send to Animator <ArrowRight size={15} /></button>
        <button className="text-button full" disabled={locked} onClick={() => setStep(2)}>Adjust clip or capture again</button>
      </> : <p className="fine-print">{take ? 'Capture motion in step 2 to review it here.' : 'Import or record a video in step 1 first.'}</p>)}

      {step === 4 && <>
        <span className="section-kicker">T-POSE CHARACTER</span>
        <label className="field-label" htmlFor="mocap-character">Character</label>
        <select id="mocap-character" aria-label="Character" disabled={locked || !snapshot.characters.length} value={characterId} onChange={e => { const c = snapshot.characters.find(item => item.id === e.target.value); if (c) selectCharacter(c) }}>
          {!snapshot.characters.length && <option value="">No characters yet</option>}
          {snapshot.characters.map(c => <option key={c.id} value={c.id}>{c.name} · {c.rigged ? 'skinned humanoid' : 'needs skin + rig'}</option>)}
        </select>
        <button className="secondary full" disabled={locked} onClick={() => void perform(async () => { const c = await window.studio.mocapImportCharacter(); if (c) selectCharacter(c) })}><Plus size={15} /> Import T-pose <span className="muted">FBX / GLB</span></button>
        {character && !character.rigged && <>
          <p className="fine-print">Mocap needs a validated skin and rig. Joints were auto-fitted on import; review them in Animator for the best result.</p>
          <button className="primary full" disabled={locked} onClick={() => void perform(async () => { await window.studio.rig(character.id); setView('character'); setNotice('Skin weights validated. This character is ready for mocap.') })}><Bone size={15} /> Build skin + rig</button>
        </>}
        {character && <button className="text-button full" disabled={locked} onClick={() => onReviewFit(character)}><Bone size={13} /> Review fit in Animator</button>}
        <div className="panel-rule" />
        <span className="section-kicker">RETARGET</span>
        <label className="field-label" htmlFor="mocap-smoothing">Smoothing <span>{Math.round(options.smoothing * 100)}%</span></label>
        <input id="mocap-smoothing" aria-label="Smoothing" type="range" min="0" max="1" step="0.05" disabled={locked} value={options.smoothing} onChange={e => setOptions({ ...options, smoothing: Number(e.target.value) })} />
        <label className="field-label" htmlFor="mocap-legs">Legs</label>
        <select id="mocap-legs" aria-label="Leg tracking" disabled={locked} value={options.legs} onChange={e => setOptions({ ...options, legs: e.target.value as MocapOptions['legs'] })}>
          <option value="auto">Auto: lock legs when they are out of view</option>
          <option value="track">Always track legs</option>
          <option value="lock">Lock legs (upper body only)</option>
        </select>
        <label className="checkbox"><input type="checkbox" disabled={locked} checked={options.hipHeight} onChange={e => setOptions({ ...options, hipHeight: e.target.checked })} /> Follow crouches (hip height)</label>
        <label className="checkbox"><input type="checkbox" disabled={locked} checked={options.mirror} onChange={e => setOptions({ ...options, mirror: e.target.checked })} /> Mirror left and right</label>
        <p className="fine-print">Motion stays in place: monocular video cannot recover reliable travel, foot contact or hidden limbs. Body only; no fingers or face.</p>
        <button className="primary full" disabled={locked || !!reason} onClick={() => void sendToAnimator()}><Send size={15} /> Export to Animator <ArrowRight size={15} /></button>
        <p className="fine-print">{reason || 'Bakes the skinned mesh with this motion in local Blender and exports FBX + GLB, then opens the result in Animator.'}</p>
        {result && <div className="output-section">
          <div className="section-kicker">EXPORTED CHARACTER</div>
          <button className="text-button full" disabled={locked || !character} onClick={() => character && onOpenAnimator(character, result.id)}>Open result in Animator <ArrowRight size={13} /></button>
          {result.outputFiles?.map(file => <button key={file} className="download" onClick={() => void perform(async () => { const path = await window.studio.saveOutput(result.id, file); if (path) setNotice(`Saved ${path}`) })}><ArrowDownToLine size={16} /><span>{outputLabel(file)}</span></button>)}
          {result.warnings?.map(w => <p className="fine-print" key={w}>{w}</p>)}
        </div>}
      </>}

      <details className="workspace-collection"><summary>Saved captures ({data?.takes.length ?? 0}){take ? ` · ${take.name}` : ''}</summary>
        <div className="asset-list mocap-list">
          {data?.takes.map(t => <div key={t.id} className={`mocap-take ${t.id === takeId ? 'active' : ''}`}>
            <button className={`asset ${t.id === takeId ? 'active' : ''}`} disabled={locked} aria-label={`Use take ${t.name}`} onClick={() => selectTake(t.id)}>
              <span className="asset-icon">{t.source === 'webcam' ? <Camera size={16} /> : <Clapperboard size={16} />}</span>
              <span><strong>{t.name}</strong><small>{t.capture ? `Captured · ${t.capture.detected}/${t.capture.frames} frames` : 'Not captured yet'} · {megabytes(t.bytes)}</small></span>
            </button>
            {confirmDelete === t.id
              ? <span className="mocap-take-confirm"><button className="secondary" disabled={locked} aria-label={`Confirm delete ${t.name}`} onClick={() => void perform(async () => { await window.studio.mocapDeleteTake(t.id); setConfirmDelete(''); setNotice('Take deleted. Exported characters were kept.') })}><Trash size={13} /> Delete</button>
                <button className="text-button" onClick={() => setConfirmDelete('')}>Keep</button></span>
              : <button className="icon-button" disabled={locked} aria-label={`Delete take ${t.name}`} onClick={() => setConfirmDelete(t.id)}><Trash size={13} /></button>}
          </div>)}
          {!data?.takes.length && <div className="empty-assets"><Clapperboard size={22} /><p>No takes yet</p><small>Imported videos and webcam takes appear here.</small></div>}
        </div>
        {take && <button className="secondary full" disabled={locked} onClick={() => { importVideo() }}><Plus size={15} /> Import another video</button>}
      </details>

      <div className="local-note"><ShieldCheck size={19} /><div>{remote
        ? <><strong>Remote capture.</strong><p>After you approve it, the entire selected video is uploaded to {route.endpoint || 'the configured provider'}. Webcam footage stays on this PC until then. Retargeting and export stay local.</p></>
        : <><strong>Captured on this PC.</strong><p>Videos, webcam footage and pose data never leave your machine. Only the pose model is downloaded once.</p></>}</div></div>
    </aside>

    <main className="workflow-main mocap-main" aria-label="Mocap scene">
      <ProcessStepper label="Mocap process" steps={processSteps} current={heading.id} onSelect={selectStep} />
      <div className="scene-heading"><div><span className="section-kicker">{step === 4 ? 'CHARACTER' : 'PERFORMANCE'}</span>
        <h2>{camera ? 'Live camera' : step === 4 ? character?.name.replace(/\.(fbx|glb)$/i, '') ?? 'Choose a T-pose character' : take?.name ?? 'Choose a performance'}</h2></div>
        {step === 4 && !camera && <div className="view-tabs">
          <button aria-pressed={view === 'character'} className={view === 'character' ? 'active' : ''} disabled={!character} onClick={() => setView('character')}>{character?.rigged ? 'Rigged' : 'Original'}</button>
          <button aria-pressed={view === 'animation'} className={view === 'animation' ? 'active' : ''} disabled={!result} onClick={() => setView('animation')}>Mocap result</button>
        </div>}
      </div>

      <div className="mocap-panes">
        <section className="mocap-pane" aria-label="Source video" hidden={step === 4 && !camera && !capturing}>
          <div className="mocap-pane-title"><span>Source video</span>{camera ? <small>Live camera · mirrored preview</small> : take && <small>{extension} · {clock(duration)}</small>}</div>
          <div ref={frameRef} className="mocap-video-frame">
            <video ref={videoRef} aria-label={camera ? 'Live camera preview' : 'Reference video playback'} src={camera ? undefined : take?.videoUrl} crossOrigin="anonymous" playsInline preload="auto" className={camera ? 'mirrored' : ''} />
            <canvas ref={overlayRef} aria-hidden="true" hidden={!!camera} />
            {!camera && !take && <div className="mocap-empty"><Clapperboard size={34} /><p>Import a video or record with your webcam.</p><small>Front-facing, full body, steady camera, good light.</small></div>}
            {countdown > 0 && <div className="mocap-countdown" role="status" aria-label="Recording countdown">{countdown}</div>}
            {recording !== undefined && <div className="mocap-recording" role="status" aria-label="Recording time"><span />REC {Math.floor(recording)}s / {MOCAP_RECORD_SECONDS}s</div>}
          </div>
          {camera ? <div className="mocap-camera-controls">
            {recording === undefined && countdown === 0 && <button className="primary" disabled={busy} onClick={startRecording}><span className="rec-dot" /> Record take</button>}
            {(recording !== undefined || countdown > 0) && <button className="primary" onClick={() => countdown > 0 ? clearTimers() : stopRecording()}><CircleStop size={15} /> {countdown > 0 ? 'Cancel countdown' : 'Stop and save take'}</button>}
            <button className="secondary" onClick={closeCamera}><CameraOff size={15} /> {recording !== undefined ? 'Discard and close camera' : 'Close camera'}</button>
            <p className="fine-print">Recording starts after a 3 second countdown and stops automatically at {MOCAP_RECORD_SECONDS} seconds. The preview is mirrored; the saved take is not.</p>
          </div> : take && <SourceControls videoRef={videoRef} frameRef={frameRef} duration={duration} disabled={capturing} clipLoop={clipLoop} />}
        </section>

        <section className="mocap-pane" aria-label="Motion preview">
          <div className="mocap-pane-title"><span>Motion preview</span><small>{capturing ? 'Live capture' : captureData ? `${captureData.frames.length} frames · ${captureData.fps} fps · world landmarks` : 'Not captured yet'}</small></div>
          <div className="mocap-preview-frame">
            {visible && (capturing || captureData) ? <PoseSkeleton key={step === 4 && !capturing ? 'loop' : 'synced'} frame={step === 4 && !capturing ? loopFrame : previewFrame} floor={captureData ? poseFloor(captureData.frames) : 0.95}
              label={capturing ? 'Live pose skeleton' : 'Captured pose skeleton synced to the source video'} />
              : <div className="mocap-empty"><ScanLine size={30} /><p>{take ? 'Capture motion to preview it here.' : 'No motion yet.'}</p><small>The 3D skeleton follows the source video during capture and review.</small></div>}
          </div>
        </section>

        {step === 4 && !camera && <section className="mocap-pane" aria-label="Character preview">
          <div className="mocap-pane-title"><span>{view === 'animation' ? 'Mocap result' : 'Character'}</span><small>{view === 'animation' ? 'Animated skinned mesh' : character ? character.rigged ? 'Skinned humanoid' : 'Needs skin + rig' : 'No character selected'}</small></div>
          <div className="mocap-preview-frame">{visible && <Viewport url={url} setup={character?.setup} fit={false} kind={view === 'animation' ? 'animation' : character?.rigged ? 'rig' : 'input'} selected="Hips" onSelect={() => undefined} onMove={() => undefined} />}</div>
        </section>}
      </div>

      {progress && <div className="job-progress" role="status" aria-label="Pose capture progress"><LoaderCircle size={17} className="spin" /><div><strong>CAPTURING MOTION · {MOCAP_MODELS[model].label.toUpperCase()}</strong><p>{progress.total ? `Frame ${progress.frame} of ${progress.total} · person found in ${progress.detected}` : 'Loading the local pose model'}</p><div className="progress-track"><span style={{ width: `${progress.total ? progress.frame / progress.total * 100 : 3}%` }} /></div></div><button onClick={() => captureAbort.current?.abort()}>Cancel capture</button></div>}
      {active && <div className="job-progress" role="status"><LoaderCircle size={17} className="spin" /><div><strong>{active.kind === 'mocap' ? 'MOCAP EXPORT · ' : active.kind === 'capture' ? 'PROVIDER CAPTURE · ' : ''}{active.stage.toUpperCase()}</strong><p>{active.message}</p><div className="progress-track"><span style={{ width: `${active.progress}%` }} /></div></div><button onClick={() => void window.studio.cancel().catch(e => setError(explain(e)))}>Cancel</button></div>}
      {error && <div className="banner error" role="alert"><CircleAlert size={18} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      {notice && <div className="banner success" role="status"><Check size={18} /><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={16} /></button></div>}

      {step < 4 && !camera && take && <Timeline videoRef={videoRef} duration={duration} clip={clip} onClip={changeClip} thumbnails={thumbnails} disabled={locked} clipLoop={clipLoop} />}

      {step === 4 && <section className="takes" aria-label="Mocap results">
        <div className="section-heading"><div><span className="section-kicker">MOCAP RESULTS</span><span className="count">{results.length}</span></div><small>Saved automatically on this PC</small></div>
        {!results.length ? <div className="no-takes"><span className="take-placeholder"><Clapperboard size={19} /></span><div><strong>No exported characters yet.</strong><p>Exports for the selected character appear here, ready to preview and open in Animator.</p></div></div> :
          <div className="take-list">{results.map(job => <button key={job.id} className={`take ${resultId === job.id ? 'selected' : ''} ${job.stage}`} disabled={job.stage !== 'complete' || locked} onClick={() => { setResultId(job.id); setView('animation') }}>
            <span className="take-icon">{job.stage === 'complete' ? <Clapperboard size={17} /> : job.stage === 'failed' ? <CircleAlert size={17} /> : <LoaderCircle size={17} />}</span>
            <span><strong>{job.label || 'Mocap take'}</strong><small>{job.stage === 'complete' ? `${job.mocapOptions?.legs === 'lock' ? 'Upper body · ' : ''}smoothing ${Math.round((job.mocapOptions?.smoothing ?? 0) * 100)}%` : job.stage}</small>{job.stage !== 'complete' && <small className="failure-text">{job.message}</small>}</span>
            <span className="take-time">{new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </button>)}</div>}
      </section>}
    </main>
    <video ref={thumbRef} src={take?.videoUrl} crossOrigin="anonymous" muted playsInline preload="auto" hidden aria-hidden="true" />
  </WorkspaceLayout>
}
