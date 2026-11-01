import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { boneLinks } from '../shared/rig'
import type { RigSetup, Vec3 } from '../shared/types'
import { Box, Crosshair, Pause, Play, RotateCcw, Scan, PersonStanding } from 'lucide-react'

interface Props {
  url?: string
  setup?: RigSetup
  fit: boolean
  selected: string
  onSelect: (name: string) => void
  onMove: (name: string, value: Vec3) => void
  kind: 'input' | 'rig' | 'animation'
}
interface SceneState {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  transform: TransformControls
  model: THREE.Group
  landmarks: THREE.Group
  bones: THREE.LineSegments
  markers: Map<string, THREE.Mesh>
  mixer?: THREE.AnimationMixer
  clips: THREE.AnimationClip[]
  clock: THREE.Clock
}

function disposeObject(root: THREE.Object3D) {
  root.traverse(obj => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose()
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
      materials.forEach(m => {
        for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose()
        m.dispose()
      })
    }
  })
}

export function Viewport(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const state = useRef<SceneState>(undefined)
  const latest = useRef(props)
  latest.current = props
  const playing = useRef(true)
  const [paused, setPaused] = useState(false)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(0)
  const [wireframe, setWireframe] = useState(false)
  useEffect(() => {
    if (!host.current) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#181c1d')
    scene.fog = new THREE.Fog('#181c1d', 9, 24)
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100)
    camera.position.set(0, 1, 5)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.25
    host.current.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 1, 0)
    controls.enableDamping = true
    controls.minDistance = 0.5
    controls.maxDistance = 20
    scene.add(new THREE.HemisphereLight('#ecf7ff', '#444e40', 2.4))
    const key = new THREE.DirectionalLight('#ffffff', 3)
    key.position.set(3, 5, 5)
    scene.add(key)
    const rim = new THREE.DirectionalLight('#b6d7ee', 2)
    rim.position.set(-3, 3, -4)
    scene.add(rim)
    const grid = new THREE.GridHelper(20, 80, '#4a5550', '#2c3434')
    scene.add(grid)
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.306, 96), new THREE.MeshBasicMaterial({ color: '#627556', side: THREE.DoubleSide }))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.001
    scene.add(ring)
    const model = new THREE.Group()
    const landmarks = new THREE.Group()
    const bones = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#d1f28b', depthTest: false, transparent: true, opacity: 0.7 }))
    bones.renderOrder = 9
    landmarks.add(bones)
    const transform = new TransformControls(camera, renderer.domElement)
    transform.setSize(0.7)
    transform.addEventListener('dragging-changed', event => { controls.enabled = !event.value })
    transform.addEventListener('objectChange', () => {
      const p = transform.object?.position
      if (p) latest.current.onMove(latest.current.selected, [p.x, p.y, p.z])
    })
    scene.add(model, landmarks, transform.getHelper())
    const current: SceneState = { scene, camera, controls, transform, model, landmarks, bones, markers: new Map(), clips: [], clock: new THREE.Clock() }
    state.current = current
    const raycaster = new THREE.Raycaster()
    const pick = (event: PointerEvent) => {
      if (!latest.current.fit || transform.dragging) return
      const rect = renderer.domElement.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera)
      const hit = raycaster.intersectObjects([...current.markers.values()])[0]
      if (hit) latest.current.onSelect(hit.object.name)
    }
    renderer.domElement.addEventListener('pointerdown', pick)
    const resize = new ResizeObserver(([entry]) => {
      camera.aspect = entry.contentRect.width / Math.max(1, entry.contentRect.height)
      camera.updateProjectionMatrix()
      renderer.setSize(entry.contentRect.width, entry.contentRect.height)
    })
    resize.observe(host.current)
    let frame = 0, lastUi = 0
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate)
      const delta = Math.min(current.clock.getDelta(), 0.1)
      if (playing.current) current.mixer?.update(delta)
      if (current.mixer && now - lastUi > 100) {
        const length = current.clips[0]?.duration ?? 0
        setTime(length ? current.mixer.time % length : 0)
        lastUi = now
      }
      controls.update()
      renderer.render(scene, camera)
    }
    frame = requestAnimationFrame(animate)
    setReady(v => v + 1)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      renderer.domElement.removeEventListener('pointerdown', pick)
      transform.dispose()
      controls.dispose()
      disposeObject(scene)
      renderer.dispose()
      renderer.domElement.remove()
      state.current = undefined
    }
  }, [])

  useEffect(() => {
    const s = state.current
    if (!s) return
    let cancelled = false
    s.mixer?.stopAllAction()
    s.mixer = undefined
    s.clips = []
    disposeObject(s.model)
    s.model.clear()
    setDuration(0); setTime(0); setError('')
    if (!props.url) return
    setLoading(true)
    const manager = new THREE.LoadingManager()
    manager.onError = () => { if (!cancelled) setError('A character texture could not load. Check the import notes and FBX texture files.') }
    new GLTFLoader(manager).load(props.url, gltf => {
      if (cancelled) { disposeObject(gltf.scene); return }
      const container = new THREE.Group()
      container.add(gltf.scene)
      s.model.add(container)
      gltf.scene.traverse(obj => {
        if (obj instanceof THREE.Mesh) { obj.frustumCulled = false }
      })
      s.clips = gltf.animations
      if (gltf.animations.length) {
        s.mixer = new THREE.AnimationMixer(gltf.scene)
        s.mixer.clipAction(gltf.animations[0]).play()
        setDuration(gltf.animations[0].duration)
        playing.current = true; setPaused(false)
      } else if (latest.current.kind === 'animation') setError('This file contains no animation. It cannot be previewed as a completed animated character.')
      setLoading(false)
      setReady(v => v + 1)
    }, undefined, error => {
      if (!cancelled) { setError(`Character preview failed: ${error instanceof Error ? error.message : String(error)}`); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [props.url])

  useEffect(() => {
    const s = state.current
    if (!s) return
    s.model.position.set(0, 0, 0)
    s.model.scale.setScalar(1)
    const orient = s.model.children[0]
    if (orient) {
      const rotation = props.kind === 'input' ? props.setup?.rotation ?? [0, 0, 0] : [0, 0, 0]
      orient.rotation.set(...rotation.map(THREE.MathUtils.degToRad) as Vec3)
      s.model.updateMatrixWorld(true)
      if (props.kind === 'input') {
        const box = new THREE.Box3().setFromObject(orient)
        const center = box.getCenter(new THREE.Vector3())
        const scale = 2 / Math.max(0.001, box.max.y - box.min.y)
        s.model.scale.setScalar(scale)
        s.model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)
      }
      s.model.traverse(o => {
        if (o instanceof THREE.Mesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if ('wireframe' in m) m.wireframe = wireframe })
      })
    }
    s.landmarks.visible = props.fit
    if (!props.fit || !props.setup) { s.transform.detach(); return }
    for (const [name, position] of Object.entries(props.setup.landmarks)) {
      let marker = s.markers.get(name)
      if (!marker) {
        marker = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 }))
        marker.name = name
        marker.renderOrder = 10
        s.markers.set(name, marker)
        s.landmarks.add(marker)
      }
      marker.position.set(...position)
      const material = marker.material as THREE.MeshBasicMaterial
      material.color.set(name === props.selected ? '#ffffff' : '#c2e986')
      marker.scale.setScalar(name === props.selected ? 1.4 : 1)
    }
    const coords = boneLinks.flatMap(([a, b]) => [...props.setup!.landmarks[a], ...props.setup!.landmarks[b]])
    s.bones.geometry.dispose()
    s.bones.geometry = new THREE.BufferGeometry()
    s.bones.geometry.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3))
    const selected = s.markers.get(props.selected)
    if (selected) s.transform.attach(selected)
  }, [props.setup, props.fit, props.selected, props.kind, ready, wireframe])

  function view(mode: 'front' | 'side' | 'reset') {
    const s = state.current
    if (!s) return
    s.controls.enableDamping = false
    s.controls.update()
    s.controls.target.set(0, 1, 0)
    s.camera.up.set(0, 1, 0)
    s.camera.position.set(...(mode === 'front' ? [0, 1, 5] : mode === 'side' ? [5, 1, 0] : [3.3, 2.2, 4.8]) as Vec3)
    s.controls.update()
    s.controls.enableDamping = true
  }
  return <div className="viewport">
    <div ref={host} className="webgl" data-testid="viewport" />
    <div className="viewport-meta"><span className="tiny-dot" />{props.kind === 'animation' ? 'ANIMATED CHARACTER' : props.fit ? 'HUMANOID RIG FIT' : 'CHARACTER VIEW'}<span className="view-format">PERSPECTIVE</span></div>
    <div className="view-tools">
      <button title="Front view" aria-label="Front view" onClick={() => view('front')}><PersonStanding size={17} /></button>
      <button title="Side view" aria-label="Side view" onClick={() => view('side')}><Box size={17} /></button>
      <button title="Reset camera" aria-label="Reset camera" onClick={() => view('reset')}><Scan size={17} /></button>
      <button title="Wireframe" aria-label="Toggle wireframe" className={wireframe ? 'selected' : ''} onClick={() => setWireframe(!wireframe)}><Crosshair size={17} /></button>
    </div>
    {!props.url && <div className="empty-viewport"><div className="character-outline"><PersonStanding size={100} strokeWidth={0.65} /></div><h2>Your character. In motion.</h2><p>Import an FBX to start building<br />a locally rigged, animated character.</p><span>FBX → RIG → MOTION → ANIMATED MESH</span></div>}
    {loading && <div className="viewport-notice"><span className="spinner" /> Loading character geometry…</div>}
    {error && <div className="viewport-error" role="alert">{error}</div>}
    <div className="viewport-hint">{props.fit ? 'Click a joint · drag its axis handles · inspect front + side' : 'Drag to orbit · scroll to zoom · right-drag to pan'}</div>
    <div className="playback">
      <button aria-label={paused ? 'Play animation' : 'Pause animation'} disabled={!duration} onClick={() => { playing.current = !playing.current; setPaused(!playing.current) }}>{paused || !duration ? <Play size={17} /> : <Pause size={17} />}</button>
      <button aria-label="Restart animation" disabled={!duration} onClick={() => { state.current?.mixer?.setTime(0); setTime(0) }}><RotateCcw size={15} /></button>
      <span className="time">{time.toFixed(2)}s</span>
      <input aria-label="Animation timeline" type="range" min="0" max={duration || 1} step="0.01" value={time} disabled={!duration} onChange={e => { const t = Number(e.target.value); state.current?.mixer?.setTime(t); setTime(t) }} />
      <span className="time">{duration.toFixed(2)}s</span><span className="loop-tag">{duration ? 'LOOP PREVIEW' : 'NO CLIP'}</span>
    </div>
  </div>
}
