"""Run with Blender --background --factory-startup --python-exit-code 1 --python this_file."""
import json
import math
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import character

# Mirrors defaultLandmarks() in src/shared/rig.ts (Three.js space, Y-up, facing +Z).
LANDMARKS = {
    "Hips": [0, 1.04, 0], "Spine1": [0, 1.2, 0], "Spine2": [0, 1.38, 0],
    "Chest": [0, 1.52, 0], "Neck1": [0, 1.68, 0], "Head": [0, 1.79, 0], "HeadEnd": [0, 1.98, 0],
    "LeftShoulder": [0.1, 1.57, 0], "LeftArm": [0.23, 1.58, 0],
    "LeftForeArm": [0.53, 1.58, 0], "LeftHand": [0.82, 1.58, 0], "LeftHandEnd": [0.98, 1.58, 0],
    "RightShoulder": [-0.1, 1.57, 0], "RightArm": [-0.23, 1.58, 0],
    "RightForeArm": [-0.53, 1.58, 0], "RightHand": [-0.82, 1.58, 0], "RightHandEnd": [-0.98, 1.58, 0],
    "LeftLeg": [0.12, 1.01, 0], "LeftShin": [0.12, 0.57, 0.035], "LeftFoot": [0.12, 0.12, 0],
    "LeftToeBase": [0.12, 0.055, 0.19], "LeftToeEnd": [0.12, 0.055, 0.3],
    "RightLeg": [-0.12, 1.01, 0], "RightShin": [-0.12, 0.57, 0.035], "RightFoot": [-0.12, 0.12, 0],
    "RightToeBase": [-0.12, 0.055, 0.19], "RightToeEnd": [-0.12, 0.055, 0.3],
}
BONES = [name for name, _, _ in character.BONES]


class BlenderMocapTests(unittest.TestCase):
    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.temp = tempfile.TemporaryDirectory(prefix="studio-mocap-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Procedural spheres along each bone; a test fixture, not a character asset.
        for name, tail, _ in character.BONES:
            center = character.C @ ((Vector(LANDMARKS[name]) + Vector(LANDMARKS[tail])) * 0.5)
            bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6, radius=0.03, location=center)
        source = self.root / "input.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(source))
        with patch.object(character, "normalize"):
            character.rig_character({"input": str(source), "output": str(self.root / "rig"), "skinning": "fallback",
                                     "setup": {"rotation": [0, 0, 0], "landmarks": LANDMARKS}})

    def motion(self, rotations, hips):
        path = self.root / "mocap-motion.json"
        path.write_text(json.dumps({"version": 1, "fps": 30, "frames": len(rotations), "bones": BONES,
                                    "rotations": rotations, "hips": hips, "legs": "tracked", "detected": len(rotations),
                                    "warnings": ["Test warning"]}))
        return path

    def test_world_deltas_bake_to_expected_bone_directions_and_exports(self):
        identity = [[1, 0, 0, 0] for _ in BONES]
        # Rotate the left forearm and hand from +X to +Z (forward) in character space.
        half = math.sqrt(0.5)
        bent = [list(q) for q in identity]
        for name in ("LeftForeArm", "LeftHand"):
            bent[BONES.index(name)] = [half, 0, -half, 0]
        output = self.root / "out"
        character.mocap_character({"input": str(self.root / "rig" / "rigged.blend"), "motion": str(self.motion([identity, bent], [[0, 0, 0], [0, -0.1, 0]])),
                                   "output": str(output)})
        for suffix in ("blend", "glb", "fbx"):
            self.assertGreater((output / f"animated.{suffix}").stat().st_size, 50)
        report = json.loads((output / "animation-report.json").read_text())
        self.assertEqual(report["frames"], 2)
        self.assertGreater(report["sampledMeshDisplacement"], 0.01)
        self.assertIn("Test warning", report["warnings"])
        if os.environ.get("STUDIO_MOCAP_TEST_OUTPUT"):
            shutil.copyfile(output / "animated.glb", Path(os.environ["STUDIO_MOCAP_TEST_OUTPUT"]) / "animated.glb")
        bpy.ops.wm.open_mainfile(filepath=str(output / "animated.blend"))
        rig = bpy.data.objects["StudioHumanoid"]
        self.assertEqual(rig.animation_data.action.name, "Video mocap")
        bpy.context.scene.frame_set(1)
        rest_hips = rig.matrix_world @ rig.pose.bones["Hips"].head
        forearm = rig.pose.bones["LeftForeArm"]
        self.assertLess(((forearm.tail - forearm.head).normalized() - character.C @ Vector((1, 0, 0))).length, 1e-4)
        bpy.context.scene.frame_set(2)
        self.assertLess(((forearm.tail - forearm.head).normalized() - character.C @ Vector((0, 0, 1))).length, 1e-4)
        upper = rig.pose.bones["LeftArm"]
        self.assertLess(((upper.tail - upper.head).normalized() - character.C @ Vector((1, 0, 0))).length, 1e-3)
        moved = rig.matrix_world @ rig.pose.bones["Hips"].head - rest_hips
        self.assertLess((moved - character.C @ Vector((0, -0.1, 0))).length, 1e-4)

    def test_rejects_incomplete_motion(self):
        path = self.motion([[[1, 0, 0, 0]] * len(BONES)], [[0, 0, 0]])
        with self.assertRaisesRegex(ValueError, "at least two"):
            character.mocap_character({"input": str(self.root / "rig" / "rigged.blend"), "motion": str(path), "output": str(self.root / "bad")})


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
