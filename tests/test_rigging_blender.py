"""Run with Blender --background --factory-startup --python-exit-code 1 --python this_file."""
import json
import sys
import tempfile
import unittest
import os
import shutil
from pathlib import Path
from unittest.mock import patch
from contextlib import contextmanager

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import character


@contextmanager
def parent_error(message):
    operator_type = type(bpy.ops.object.parent_set)
    original = operator_type.__call__

    def call(operator, *args, **kwargs):
        if operator.idname() == "OBJECT_OT_parent_set":
            raise RuntimeError(message)
        return original(operator, *args, **kwargs)

    with patch.object(operator_type, "__call__", call):
        yield


class BlenderSkinTests(unittest.TestCase):
    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.temp = tempfile.TemporaryDirectory(prefix="studio-rig-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.points = {}
        for index, (name, tail, _) in enumerate(character.BONES):
            self.points.setdefault(name, (index * 0.07 - 0.7, 1 + index * 0.015, 0))
            self.points.setdefault(tail, (index * 0.07 - 0.63, 1 + index * 0.015, 0))
        # Procedural test geometry, not a character asset or evidence of motion quality.
        for name, tail, _ in character.BONES:
            center = character.C @ ((Vector(self.points[name]) + Vector(self.points[tail])) * 0.5)
            bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6, radius=0.02, location=center)
        self.input = self.root / "input.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(self.input))
        self.request = {"input": str(self.input), "output": str(self.root / "output"),
                        "setup": {"rotation": [0, 0, 0], "landmarks": self.points}}

    def run_rig(self, mode, heat_error=False):
        request = {**self.request, "skinning": mode}
        # Keep the procedural fixture aligned with its landmarks. Production normalization
        # is exercised separately by the import/desktop integration harness.
        with patch.object(character, "normalize"):
            if heat_error:
                with parent_error("Bone Heat Weighting: failed to find solution for one or more bones"):
                    character.rig_character(request)
            else:
                character.rig_character(request)

    def test_failed_heat_never_saves_incomplete_output(self):
        with self.assertRaises(character.UnweightedSkinError):
            self.run_rig("automatic", heat_error=True)
        self.assertFalse((self.root / "output" / "rigged.blend").exists())
        self.assertFalse((self.root / "output" / "rigged.glb").exists())

    def test_fallback_exports_complete_skin_and_keeps_fitted_bones(self):
        original = {obj.name: [obj.matrix_world @ v.co for v in obj.data.vertices] for obj in character.meshes()}
        self.run_rig("fallback", heat_error=True)
        report = json.loads((self.root / "output" / "rig-report.json").read_text())
        self.assertEqual(report["vertices"], report["weightedVertices"])
        self.assertEqual(report["repair"]["fallbackVertices"], report["vertices"])
        self.assertTrue(any("Approximate fallback" in warning for warning in report["warnings"]))
        bpy.ops.wm.open_mainfile(filepath=str(self.root / "output" / "rigged.blend"))
        rig = bpy.data.objects["StudioHumanoid"]
        for name, tail, _ in character.BONES:
            self.assertLess((rig.data.bones[name].head_local - character.C @ Vector(self.points[name])).length, 1e-6)
            self.assertLess((rig.data.bones[name].tail_local - character.C @ Vector(self.points[tail])).length, 1e-6)
        self.assertTrue(json.loads(rig["studio_skinning_warnings"]))
        for obj in character.meshes():
            for vertex in obj.data.vertices:
                self.assertLess((obj.matrix_world @ vertex.co - original[obj.name][vertex.index]).length, 1e-6)
                self.assertLessEqual(len(vertex.groups), 4)
                self.assertAlmostEqual(sum(group.weight for group in vertex.groups), 1, places=5)
        rig.pose.bones["LeftArm"].rotation_mode = "XYZ"
        rig.pose.bones["LeftArm"].rotation_euler.y = 0.5
        bpy.context.view_layer.update()
        displacement = max((obj.matrix_world @ obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices[v.index].co - original[obj.name][v.index]).length
                           for obj in character.meshes() for v in obj.data.vertices)
        self.assertGreater(displacement, 0.001)
        if os.environ.get("STUDIO_RIG_TEST_OUTPUT"):
            shutil.copyfile(self.root / "output" / "rigged.glb", Path(os.environ["STUDIO_RIG_TEST_OUTPUT"]) / "rigged.glb")
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(self.root / "output" / "rigged.glb"), disable_bone_shape=True)
        rig = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
        exported = character.validate_skin(rig, character.meshes())
        self.assertEqual(exported["weightedVertices"], exported["vertices"])
        # glTF splits vertices at UV/normal seams.
        self.assertGreaterEqual(exported["vertices"], report["vertices"])
        self.assertEqual(len(character.meshes()), len(character.BONES))

    def test_real_bone_heat_with_recovery_exports(self):
        self.run_rig("fallback")
        report = json.loads((self.root / "output" / "rig-report.json").read_text())
        self.assertEqual(report["vertices"], report["weightedVertices"])

    def test_unrelated_blender_errors_are_not_swallowed(self):
        with parent_error("Unexpected operator error"):
            with self.assertRaisesRegex(RuntimeError, "Unexpected operator"):
                self.run_rig("fallback")
        self.assertFalse((self.root / "output" / "rigged.blend").exists())

    def test_missing_required_bone_influence_still_blocks(self):
        self.run_rig("fallback", heat_error=True)
        rig = bpy.data.objects["StudioHumanoid"]
        for obj in character.meshes():
            group = obj.vertex_groups.get("Head")
            if group:
                obj.vertex_groups.remove(group)
            hips = obj.vertex_groups.get("Hips") or obj.vertex_groups.new(name="Hips")
            for vertex in obj.data.vertices:
                if not any(g.weight > 1e-6 for g in vertex.groups):
                    hips.add([vertex.index], 1, "REPLACE")
        with self.assertRaisesRegex(ValueError, "required bones: Head"):
            character.validate_skin(rig, character.meshes())

    def test_connected_repair_keeps_valid_weights(self):
        self.run_rig("fallback")
        rig = bpy.data.objects["StudioHumanoid"]
        obj = character.meshes()[0]
        preserved = {v.index: [(g.group, g.weight) for g in v.groups] for v in obj.data.vertices if v.index >= 5}
        for group in obj.vertex_groups:
            group.remove(list(range(5)))
        report = character.repair_skin(rig, character.meshes(), False)
        self.assertEqual(report, {"connectedVertices": 5, "fallbackVertices": 0})
        character.validate_skin(rig, character.meshes())
        for index, weights in preserved.items():
            self.assertEqual([(g.group, g.weight) for g in obj.data.vertices[index].groups], weights)


suite = unittest.defaultTestLoader.loadTestsFromTestCase(BlenderSkinTests)
sys.path.insert(0, str(Path(__file__).resolve().parent))
suite.addTests(unittest.defaultTestLoader.loadTestsFromName("test_skin_weights"))
if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
    raise RuntimeError("Rigging regression tests failed")
