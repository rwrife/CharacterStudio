import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { POSE_LINKS, POSE_POINTS, type PoseFrame } from '../shared/mocap'

interface Props {
  /** Called every animation frame; returns the 33 world landmarks to draw, or undefined for no pose. */
  frame: () => PoseFrame | undefined
  /** Floor height in MediaPipe world units (metres below the hips, y down). */
  floor?: number
  label: string
}

const BODY = POSE_LINKS.filter(([a, b]) => a >= 11 && b >= 11)

/** Lightweight Three.js view of MediaPipe world landmarks; no character or rig is involved. */
export function PoseSkeleton({ frame, floor = 0.95, label }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ frame, floor })
  latest.current = { frame, floor }

  useEffect(() => {
    if (!host.current) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#141a18')
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 50)
    camera.position.set(0.9, 1.1, 3.6)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    host.current.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.95, 0)
    controls.enableDamping = true
    controls.minDistance = 1
    controls.maxDistance = 10
    const grid = new THREE.GridHelper(6, 24, '#4c5a4a', '#273029')
    scene.add(grid)
    const positions = new Float32Array(BODY.length * 6)
    const lineGeometry = new THREE.BufferGeometry()
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: '#c8f06a' }))
    const jointMaterial = new THREE.MeshBasicMaterial({ color: '#f2ffd9' })
    const joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.022, 10, 8), jointMaterial, POSE_POINTS - 11)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), new THREE.MeshBasicMaterial({ color: '#c8f06a', wireframe: true }))
    const figure = new THREE.Group()
    figure.add(lines, joints, head)
    scene.add(figure)
    const matrix = new THREE.Matrix4()
    const point = (frame: NonNullable<PoseFrame>, index: number, floor: number) => new THREE.Vector3(frame[index][0], floor - frame[index][1], -frame[index][2])
    const resize = new ResizeObserver(([entry]) => {
      camera.aspect = entry.contentRect.width / Math.max(1, entry.contentRect.height)
      camera.updateProjectionMatrix()
      renderer.setSize(entry.contentRect.width, entry.contentRect.height)
    })
    resize.observe(host.current)
    let handle = 0
    const animate = () => {
      handle = requestAnimationFrame(animate)
      const { frame, floor } = latest.current
      const pose = frame()
      figure.visible = !!pose
      if (pose) {
        BODY.forEach(([a, b], i) => {
          point(pose, a, floor).toArray(positions, i * 6)
          point(pose, b, floor).toArray(positions, i * 6 + 3)
        })
        lineGeometry.attributes.position.needsUpdate = true
        lineGeometry.computeBoundingSphere()
        for (let k = 11; k < POSE_POINTS; k++) joints.setMatrixAt(k - 11, matrix.makeTranslation(point(pose, k, floor)))
        joints.instanceMatrix.needsUpdate = true
        const nose = point(pose, 0, floor), left = point(pose, 7, floor), right = point(pose, 8, floor)
        head.position.copy(left.add(right).multiplyScalar(0.5).lerp(nose, 0.35))
      }
      controls.update()
      renderer.render(scene, camera)
    }
    handle = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(handle)
      resize.disconnect()
      controls.dispose()
      lineGeometry.dispose()
      joints.geometry.dispose()
      jointMaterial.dispose()
      head.geometry.dispose()
      ;(head.material as THREE.Material).dispose()
      grid.geometry.dispose()
      ;(grid.material as THREE.Material).dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={host} className="pose-skeleton" role="img" aria-label={label} />
}

/** Distance from the hips down to the feet across a capture, used to stand the preview on the grid. */
export function poseFloor(frames: PoseFrame[]) {
  const feet: number[] = []
  for (const frame of frames) if (frame) for (const k of [27, 28, 29, 30, 31, 32]) if (frame[k][3] > 0.5) feet.push(frame[k][1])
  if (feet.length < 10) return 0.95
  feet.sort((a, b) => a - b)
  return feet[Math.floor(feet.length * 0.95)]
}
