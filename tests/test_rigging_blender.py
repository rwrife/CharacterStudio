"""Run with Blender --background --factory-startup --python-exit-code 1 --python this_file."""
import json
import math
import sys
import tempfile
import unittest
import os
import shutil
from pathlib import Path
from unittest.mock import patch
from contextlib import contextmanager

import bmesh
import bpy
from mathutils import Matrix, Vector

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
            bpy.context.object["fixture_bone"] = name
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

    def add_occluded_seam_island(self):
        # Mirrors a failure seen on a generated character: a small UV-seam island whose
        # vertices cannot see their nearest bone receives no heat until its rim is welded.
        center = character.C @ ((Vector(self.points["Head"]) + Vector(self.points["HeadEnd"])) * 0.5)
        obj = min(character.meshes(), key=lambda o: (o.location - center).length)
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.rotate(bm, verts=bm.verts, cent=Vector(), matrix=Matrix.Rotation(math.radians(90), 3, "X"))
        ring = sorted((v for v in bm.verts if abs(-v.co.y - 0.02 * math.cos(math.radians(30))) < 1e-4),
                      key=lambda v: math.atan2(v.co.z, v.co.x))
        base = [bm.verts.new(v.co.copy()) for v in ring]
        far = [bm.verts.new(v.co + Vector((0, -0.01, 0))) for v in ring]
        rim = [bm.verts.new(v.co.copy()) for v in far]
        tip = bm.verts.new(sum((v.co for v in far), Vector()) / len(far) + Vector((0, -0.001, 0)))
        for i in range(len(ring)):
            j = (i + 1) % len(ring)
            bm.faces.new((base[i], base[j], far[j], far[i]))
            bm.faces.new((tip, rim[i], rim[j]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(obj.data)
        bm.free()
        bpy.ops.wm.save_as_mainfile(filepath=str(self.input))

    def test_seam_split_islands_are_skinned_from_welded_copies(self):
        self.add_occluded_seam_island()
        original = {obj.name: [obj.matrix_world @ v.co for v in obj.data.vertices] for obj in character.meshes()}
        with patch.object(character, "welded_heat_proxy", return_value=None), patch.object(character, "HEAT_RETRY_LIMIT", 0):
            with self.assertRaises(character.UnweightedSkinError):
                self.run_rig("automatic")
        self.assertFalse((self.root / "output" / "rigged.blend").exists())
        self.run_rig("automatic")
        report = json.loads((self.root / "output" / "rig-report.json").read_text())
        self.assertEqual(report["vertices"], report["weightedVertices"])
        self.assertEqual(report["repair"], {"connectedVertices": 0, "fallbackVertices": 0})
        self.assertEqual(report["seamWeld"], {"meshes": 1, "mergedVertices": 16})
        self.assertEqual(report["heatRetry"], {"pieces": 0, "solvedPieces": 0, "vertices": 0, "skippedPieces": 0})
        bpy.ops.wm.open_mainfile(filepath=str(self.root / "output" / "rigged.blend"))
        self.assertEqual({obj.name for obj in character.meshes()}, set(original))
        for obj in character.meshes():
            self.assertEqual(len(obj.data.vertices), len(original[obj.name]))
            weights = {}
            for vertex in obj.data.vertices:
                self.assertLess((obj.matrix_world @ vertex.co - original[obj.name][vertex.index]).length, 1e-6)
                self.assertAlmostEqual(sum(group.weight for group in vertex.groups), 1, places=5)
                key = tuple(round(c, 5) for c in vertex.co)
                skin = sorted((obj.vertex_groups[g.group].name, round(g.weight, 5)) for g in vertex.groups)
                # Coincident seam vertices share weights, so the seam cannot crack when posed.
                self.assertEqual(weights.setdefault(key, skin), skin)

    def add_sealed_piece(self):
        # Blender bone heat treats front-facing triangles as occluders. A detached piece enclosed by an
        # inward-facing (hollow or double-sided) shell cannot see any bone, receives no heat, and makes the
        # combined solve for its whole object singular; there are no seams for welding to join.
        head, tail = (character.C @ Vector(self.points[name]) for name in ("Head", "HeadEnd"))
        obj = min(character.meshes(), key=lambda o: (o.location - (head + tail) * 0.5).length)
        direction = (tail - head).normalized()
        side = direction.cross(Vector((0, 0, 1)))
        if side.length < 1e-3:
            side = direction.cross(Vector((1, 0, 0)))
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        shell = [bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius,
                                            matrix=Matrix.Translation(side.normalized() * 0.045))["verts"]
                 for radius in (0.012, 0.004)][0]
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.reverse_faces(bm, faces=list({face for vertex in shell for face in vertex.link_faces}))
        bm.to_mesh(obj.data)
        bm.free()
        bpy.ops.wm.save_as_mainfile(filepath=str(self.input))
        return obj.name, len(obj.data.vertices), 12

    def test_hidden_detached_pieces_are_solved_separately(self):
        name, count, hidden = self.add_sealed_piece()
        with patch.object(character, "HEAT_RETRY_LIMIT", 0):
            with self.assertRaises(character.UnweightedSkinError):
                self.run_rig("automatic")
        self.assertFalse((self.root / "output" / "rigged.blend").exists())
        self.run_rig("automatic")
        report = json.loads((self.root / "output" / "rig-report.json").read_text())
        self.assertEqual(report["vertices"], report["weightedVertices"])
        self.assertEqual(report["repair"], {"connectedVertices": 0, "fallbackVertices": 0})
        self.assertEqual(report["heatRetry"], {"pieces": 1, "solvedPieces": 1, "vertices": hidden, "skippedPieces": 0})
        self.assertTrue(any("solved separately for 1 mesh piece" in warning for warning in report["warnings"]))
        bpy.ops.wm.open_mainfile(filepath=str(self.root / "output" / "rigged.blend"))
        obj = bpy.data.objects[name]
        self.assertEqual(len(obj.data.vertices), count)
        self.assertEqual(len([o for o in bpy.data.objects if "StudioHeat" in o.name]), 0)
        for vertex in obj.data.vertices:
            self.assertAlmostEqual(sum(group.weight for group in vertex.groups), 1, places=5)

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

    def test_wrist_offsets_bake_without_changing_skin_or_source_motion(self):
        self.run_rig("fallback")
        rig = bpy.data.objects["StudioHumanoid"]
        for obj in character.meshes():
            obj.vertex_groups.clear()
            obj.vertex_groups.new(name=obj["fixture_bone"]).add(list(range(len(obj.data.vertices))), 1, "REPLACE")
        character.validate_skin(rig, character.meshes())
        rest = {name: rig.data.bones[name].matrix_local.to_quaternion().copy() for name, _, _ in character.BONES}
        source = self.root / "source.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(source))
        names = list(self.points)
        positions = dict(self.points)
        for side in ("Left", "Right"):
            names.append(side + "HandMiddle1")
            positions[side + "HandMiddle1"] = positions[side + "HandEnd"]
        rotations = [[list(row) for row in Matrix.Identity(3)] for _ in names]
        second = json.loads(json.dumps(rotations))
        second[names.index("LeftHand")] = [list(row) for row in Matrix.Rotation(0.4, 3, "Y")]
        motion = self.root / "motion.json"
        motion.write_text(json.dumps({
            "joint_names": names, "neutral_joints": [positions[name] for name in names],
            "global_rot_mats": [rotations, second],
            "root_positions": [positions["Hips"], positions["Hips"]], "fps": 30
        }))
        original_motion = motion.read_bytes()
        pose = {"version": 1, "detail": "wrist", "left": [31, -42, 63], "right": [0, 0, 0]}
        baseline = {}
        weights = None
        for label, hand_pose in (("base", None), ("offset", pose)):
            output = self.root / label
            character.animate_character({
                "input": str(source), "motion": str(motion), "output": str(output), "handPose": hand_pose
            })
            rig = bpy.data.objects["StudioHumanoid"]
            current_weights = {o.name: [[(o.vertex_groups[g.group].name, g.weight) for g in v.groups] for v in o.data.vertices]
                               for o in character.meshes()}
            if label == "base":
                weights = current_weights
            else:
                self.assertEqual(current_weights, weights)
            for frame in (1, 2):
                bpy.context.scene.frame_set(frame)
                values = {bone.name: bone.rotation_quaternion.copy() for bone in rig.pose.bones}
                if label == "base":
                    baseline[frame] = values
                else:
                    offsets = character.hand_corrections(pose, rest)
                    for name, value in values.items():
                        expected = baseline[frame][name]
                        if name in offsets:
                            expected = expected @ offsets[name]
                        self.assertLess(value.rotation_difference(expected).angle, 0.001)
            report = json.loads((output / "animation-report.json").read_text())
            self.assertEqual(report["handPose"], hand_pose)
            self.assertEqual(motion.read_bytes(), original_motion)
            if os.environ.get("STUDIO_RIG_TEST_OUTPUT"):
                destination = Path(os.environ["STUDIO_RIG_TEST_OUTPUT"])
                shutil.copyfile(output / "animated.glb", destination / f"hand-{label}.glb")
                (destination / "hand-pose.json").write_text(json.dumps(pose))
            # Reimport FBX and check its actual baked wrist matrix at the first frame.
            bpy.context.scene.frame_set(1)
            expected_matrix = rig.pose.bones["LeftHand"].matrix.copy()
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.fbx(filepath=str(output / "animated.fbx"), ignore_leaf_bones=False)
            bpy.context.scene.frame_set(1)
            imported = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
            self.assertLess(imported.pose.bones["LeftHand"].matrix.to_quaternion().rotation_difference(expected_matrix.to_quaternion()).angle, 0.001)

    def test_hand_pose_validation_and_rest_frame(self):
        rest = {"LeftHand": Matrix.Rotation(0.9, 3, "Z").to_quaternion(), "RightHand": Matrix.Rotation(-0.4, 3, "X").to_quaternion()}
        pose = {"version": 1, "detail": "wrist", "left": [90, 0, 0], "right": [0, 0, 0]}
        offsets = character.hand_corrections(pose, rest)
        expected = (character.C @ Matrix.Rotation(math.pi / 2, 3, "X") @ character.C.inverted()).to_quaternion() @ rest["LeftHand"]
        self.assertLess((rest["LeftHand"] @ offsets["LeftHand"]).rotation_difference(expected).angle, 0.001)
        self.assertLess(offsets["RightHand"].angle, 0.001)
        self.assertEqual(character.hand_corrections(None, rest), {})
        for invalid in ({}, {**pose, "detail": "basic"}, {**pose, "version": True}, {**pose, "extra": 1},
                        {**pose, "left": [0, 0, 181]}, {**pose, "left": [0, 0, float("nan")]},
                        {**pose, "right": [0, 0, True]}, {**pose, "left": [0, 0]}):
            with self.assertRaises(ValueError):
                character.hand_corrections(invalid, rest)


suite = unittest.defaultTestLoader.loadTestsFromTestCase(BlenderSkinTests)
sys.path.insert(0, str(Path(__file__).resolve().parent))
suite.addTests(unittest.defaultTestLoader.loadTestsFromName("test_skin_weights"))
suite.addTests(unittest.defaultTestLoader.loadTestsFromName("test_hand_rig_blender"))
if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
    raise RuntimeError("Rigging regression tests failed")
