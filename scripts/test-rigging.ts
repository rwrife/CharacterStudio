import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundledBlenderPath } from '../src/main/native-runtime'
import { validateCharacterGlb } from '../src/main/export-validation'
import assert from 'node:assert/strict'
import { AnimationMixer, Bone, LoopOnce, Quaternion, SkinnedMesh, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { wristCorrection } from '../src/shared/hand-pose'
import { handPoseSchema } from '../src/main/validation'
import { fingerChains, fingerRotation, handPrefix, handSides } from '../src/shared/hand-rig'
import { poseAt } from '../src/shared/hand-animation'

const output = await mkdtemp(join(tmpdir(), 'studio-native-skin-'))
try {
  execFileSync(bundledBlenderPath(resolve('.')), [
    '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
    '--python', resolve('tests', 'test_rigging_blender.py')
  ], { stdio: 'inherit', env: { ...process.env, STUDIO_RIG_TEST_OUTPUT: output } })
  await validateCharacterGlb(join(output, 'rigged.glb'), false)
  await validateCharacterGlb(join(output, 'fixed-grip.glb'), false)
  const load = async (label: string) => {
    const file = join(output, `${label}.glb`)
    await validateCharacterGlb(file, true)
    const gltf = await new GLTFLoader().parseAsync(new Uint8Array(await readFile(file)).buffer, '')
    const mixer = new AnimationMixer(gltf.scene)
    mixer.clipAction(gltf.animations[0]).setLoop(LoopOnce, 1).play().clampWhenFinished = true
    gltf.scene.updateMatrixWorld(true)
    return { ...gltf, mixer }
  }
  const vertices = (root: import('three').Group) => {
    root.updateMatrixWorld(true)
    const result = new Map<string, Vector3[]>()
    root.traverse(object => {
      if (object instanceof SkinnedMesh) {
        object.skeleton.update()
        result.set(object.name, Array.from({ length: object.geometry.attributes.position.count }, (_, i) =>
          object.getVertexPosition(i, new Vector3()).applyMatrix4(object.matrixWorld)))
      }
    })
    return result
  }
  for (const feature of ['hand', 'fingers']) {
    const savedPose = handPoseSchema.parse(JSON.parse(await readFile(join(output, `${feature}-pose.json`), 'utf8')))
    for (const time of feature === 'fingers' ? [0, 1 / 30, 2 / 30] : [0, 1 / 30]) {
      const pose = poseAt(savedPose, feature === 'fingers' ? time * 15 : time * 30)
      const base = await load(`${feature}-base`), offset = await load(`${feature}-offset`)
      const wrists = (['left', 'right'] as const).map(side => {
        const bone = base.scene.getObjectByName(side === 'left' ? 'LeftHand' : 'RightHand')
        assert.ok(bone instanceof Bone)
        return { bone, correction: wristCorrection(pose[side], bone.getWorldQuaternion(new Quaternion())) }
      })
      base.mixer.setTime(time)
      offset.mixer.setTime(time)
      const unposed = vertices(base.scene)
      for (const { bone, correction } of wrists) bone.quaternion.multiply(correction)
      if (pose.version === 2) for (const side of handSides) for (const chain of fingerChains) for (let i = 0; i < chain.segments; i++) {
        const bone = base.scene.getObjectByName(`${handPrefix(side)}${chain.name}${i + 1}`)
        assert.ok(bone instanceof Bone)
        bone.quaternion.multiply(fingerRotation(side, chain, i, pose.fingers[side]))
      }
      const preview = vertices(base.scene), exported = vertices(offset.scene)
      let displacement = 0
      for (const [name, points] of preview) {
        const actual = exported.get(name)
        assert.equal(actual?.length, points.length)
        points.forEach((point, i) => {
          assert.ok(point.distanceTo(actual![i]) < 0.0001, `Renderer/Blender mismatch at ${time}: ${name} vertex ${i}, distance ${point.distanceTo(actual![i])}`)
          displacement = Math.max(displacement, point.distanceTo(unposed.get(name)![i]))
        })
      }
      assert.ok(displacement > 0.001, 'The fixture wrist must visibly deform the skinned mesh.')
    }
  }
  console.log('Wrist and three-chain finger previews match native baked GLB vertices across sampled frames; FBX round-trips verified by Blender.')
  console.log('Fallback GLB passed the desktop character-export validator.')
} finally {
  await rm(output, { recursive: true, force: true })
}
