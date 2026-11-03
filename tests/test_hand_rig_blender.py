"""Native guided-hand fixture; no third-party mesh or inference weights."""
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import bpy
from mathutils import Matrix, Vector
import character
from hand_rig import CHAINS, finger_corrections


def fixture_setup():
    points = {"Hips": [0, 1.04, 0], "Spine1": [0, 1.2, 0], "Spine2": [0, 1.38, 0],
              "Chest": [0, 1.52, 0], "Neck1": [0, 1.68, 0], "Head": [0, 1.79, 0], "HeadEnd": [0, 1.98, 0]}
    hands = {}
    for side, sign in (("Left", 1), ("Right", -1)):
        values = {"Shoulder": [.1, 1.57, 0], "Arm": [.23, 1.58, 0], "ForeArm": [.53, 1.58, 0],
                  "Hand": [.82, 1.58, 0], "HandEnd": [.98, 1.58, 0], "PalmNormal": [.82, 1.66, 0],
                  "Leg": [.12, 1.01, 0], "Shin": [.12, .57, .035], "Foot": [.12, .12, 0],
                  "ToeBase": [.12, .055, .19], "ToeEnd": [.12, .055, .3],
                  "Thumb1": [.86, 1.58, .0288], "Thumb2": [.8968, 1.58, .0608], "Thumb3": [.9272, 1.58, .0768],
                  "Index1": [.9, 1.58, .024], "Index2": [.9352, 1.58, .024], "Index3": [.9608, 1.58, .024], "Index4": [.98, 1.58, .024],
                  "Fingers1": [.9, 1.58, -.024], "Fingers2": [.9352, 1.58, -.024], "Fingers3": [.9608, 1.58, -.024], "Fingers4": [.98, 1.58, -.024]}
        points.update({side + name: [sign * p[0], p[1], p[2]] for name, p in values.items()})
        hands[side.lower()] = {"detail": "basic", "thumbRadius": .0192, "indexRadius": .016, "fingersRadius": .0384}
    return {"rotation": [0, 0, 0], "landmarks": points, "hands": hands}


def add_segment(name, head, tail, radius):
    head, tail = character.C @ Vector(head), character.C @ Vector(tail)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=1)
    obj = bpy.context.object
    obj.name = name
    obj.location = (head + tail) * .5
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = (tail - head).to_track_quat("Z", "Y")
    obj.scale = (radius, radius, (tail - head).length * .5 + radius)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


class BlenderHandTests(unittest.TestCase):
    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.temp = tempfile.TemporaryDirectory(prefix="studio-three-chain-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.setup = fixture_setup()
        points = self.setup["landmarks"]
        for name, tail, _ in character.BONES:
            end = points[tail] if not name.endswith("Hand") else [(points[name][0] + points[tail][0]) * .5, 1.58, 0]
            add_segment("Body_" + name, points[name], end, .02 if name == "Head" else .055 if "Toe" in name else .025)
        for side in ("Left", "Right"):
            for chain, _, count, _ in CHAINS:
                for i in range(count):
                    name = f"{side}{chain}{i + 1}"
                    add_segment(name, points[name], points[f"{side}{chain}{i + 2}"], .009 if chain != "Fingers" else .015)
        lo, hi = character.bounds(character.meshes())
        offset = Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
        scale = 2 / (hi.z - lo.z)
        self.setup["landmarks"] = {name: list(character.C.inverted() @ ((character.C @ Vector(point) + offset) * scale))
                                   for name, point in points.items()}
        character.normalize(character.meshes())
        self.source = self.root / "character.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(self.source))

    def rig(self):
        character.rig_character({"input": str(self.source), "setup": self.setup, "output": str(self.root / "rig"), "skinning": "fallback"})
        return bpy.data.objects["StudioHumanoid"]

    def test_native_finger_skin_preview_and_exports(self):
        rig = self.rig()
        self.assertEqual(len(rig.data.bones), 38)
        report = json.loads((self.root / "rig" / "rig-report.json").read_text())
        self.assertEqual(report["weightedVertices"], report["vertices"])
        self.assertTrue(all(count >= 3 for hand in report["hands"].values() for count in hand.values()))
        before = {o.name: [v.co.copy() for v in o.data.vertices] for o in character.meshes()}
        pose = {"version": 2, "detail": "basic", "left": [15, -20, 10], "right": [0, 0, 0],
                "fingers": {"left": {"thumb": .6, "index": .8, "fingers": 1, "opposition": .4},
                            "right": {"thumb": 0, "index": 0, "fingers": 0, "opposition": 0}}}
        controls = finger_corrections(pose, rig)
        for name, rotation in controls.items():
            rig.pose.bones[name].rotation_mode = "QUATERNION"
            rig.pose.bones[name].rotation_quaternion = rotation
        bpy.context.view_layer.update()
        for prefix in ("LeftThumb", "LeftIndex", "LeftFingers"):
            moved = max((v.co - before[o.name][v.index]).length for o in character.meshes() if o.name.startswith(prefix)
                        for v in o.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices)
            self.assertGreater(moved, .002)
        for obj in character.meshes():
            if obj.name.startswith(("Right", "Body_")):
                # Body vertices near the knuckles can blend; the opposite hand and torso must not move.
                if obj.name.startswith("Body_LeftHand"):
                    continue
                self.assertLess(max((v.co - before[obj.name][v.index]).length for v in obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices), 1e-5, obj.name)
        points = self.setup["landmarks"]
        names = list(points)
        for side in ("Left", "Right"):
            names.append(side + "HandMiddle1")
        neutral = [points.get(name, points[name.replace("HandMiddle1", "HandEnd")]) if "HandMiddle1" in name else points[name] for name in names]
        rotations = [[list(row) for row in Matrix.Identity(3)] for _ in names]
        second = json.loads(json.dumps(rotations))
        second[names.index("LeftHand")] = [list(row) for row in Matrix.Rotation(.25, 3, "Y")]
        motion = self.root / "motion.json"
        motion.write_text(json.dumps({"joint_names": names, "neutral_joints": neutral, "global_rot_mats": [rotations, second, rotations],
                                     "root_positions": [points["Hips"], points["Hips"], points["Hips"]], "fps": 30}))
        open_pose = {side: {key: 0 for key in pose["fingers"][side]} for side in ("left", "right")}
        pose["keyframes"] = [{"time": 0, "fingers": open_pose}, {"time": .5, "fingers": pose["fingers"]}, {"time": 1, "fingers": open_pose}]
        source_bytes = self.source.read_bytes()
        prefix_matrices = {}
        for label, hand_pose in (("base", None), ("offset", pose)):
            output = self.root / label
            character.animate_character({"input": str(self.root / "rig" / "rigged.blend"), "motion": str(motion),
                                         "output": str(output), "handPose": hand_pose})
            rig = bpy.data.objects["StudioHumanoid"]
            bpy.context.scene.frame_set(2)
            expected = rig.pose.bones["LeftIndex3"].matrix.copy()
            if label == "offset":
                for frame in (1, 2, 3):
                    bpy.context.scene.frame_set(frame)
                    prefix_matrices[frame] = rig.pose.bones["LeftIndex3"].matrix.copy()
            if os.environ.get("STUDIO_RIG_TEST_OUTPUT"):
                destination = Path(os.environ["STUDIO_RIG_TEST_OUTPUT"])
                shutil.copyfile(output / "animated.glb", destination / f"fingers-{label}.glb")
                (destination / "fingers-pose.json").write_text(json.dumps(pose))
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bpy.ops.import_scene.fbx(filepath=str(output / "animated.fbx"), ignore_leaf_bones=False, anim_offset=0)
            bpy.context.scene.frame_set(2)
            imported = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
            self.assertLess(imported.pose.bones["LeftIndex3"].matrix.to_quaternion().rotation_difference(expected.to_quaternion()).angle, .001,
                            f"{label}: imported action frames {list(imported.animation_data.action.frame_range)}, fps {bpy.context.scene.render.fps}")
        assembled = json.loads(motion.read_text())
        assembled["global_rot_mats"] += [rotations] * 4
        assembled["root_positions"] += [points["Hips"]] * 4
        motion.write_text(json.dumps(assembled))
        closed_pose = {key: value for key, value in pose.items() if key != "keyframes"}
        transition = {**closed_pose, "keyframes": [{"time": 0, "fingers": open_pose}, {"time": 1, "fingers": pose["fingers"]}]}
        timeline = [{"start": 0, "end": 2, "pose": pose}, {"start": 2, "end": 4, "pose": transition},
                    {"start": 4, "end": 6, "pose": closed_pose}]
        character.animate_character({"input": str(self.root / "rig" / "rigged.blend"), "motion": str(motion),
                                     "output": str(self.root / "branch"), "handPose": closed_pose, "handTimeline": timeline})
        rig = bpy.data.objects["StudioHumanoid"]
        for frame, expected in prefix_matrices.items():
            bpy.context.scene.frame_set(frame)
            self.assertLess(rig.pose.bones["LeftIndex3"].matrix.to_quaternion().rotation_difference(expected.to_quaternion()).angle, .001)
        bpy.context.scene.frame_set(7)
        expected = finger_corrections(closed_pose, rig)["LeftIndex3"]
        self.assertLess(rig.pose.bones["LeftIndex3"].rotation_quaternion.rotation_difference(expected).angle, .001)
        with self.assertRaisesRegex(ValueError, "jump at a path seam"):
            character.animate_character({"input": str(self.root / "rig" / "rigged.blend"), "motion": str(motion),
                                         "output": str(self.root / "invalid-branch"), "handPose": closed_pose,
                                         "handTimeline": [timeline[0], {"start": 2, "end": 6, "pose": closed_pose}]})
        self.assertFalse((self.root / "invalid-branch" / "animated.glb").exists())
        self.assertEqual(self.source.read_bytes(), source_bytes)

    def test_missing_hand_geometry_is_not_a_success(self):
        for obj in list(character.meshes()):
            if obj.name.startswith("LeftThumb"):
                bpy.data.objects.remove(obj, do_unlink=True)
        # Move the thumb chain entirely away from every surface; it must not borrow index weights.
        for name in ("LeftThumb1", "LeftThumb2", "LeftThumb3"):
            self.setup["landmarks"][name][2] += .2
        bpy.ops.wm.save_as_mainfile(filepath=str(self.source))
        with self.assertRaisesRegex(ValueError, "Left Thumb.*influenced vertices"):
            self.rig()
        self.assertFalse((self.root / "rig" / "rigged.glb").exists())

    def test_fixed_grip_preserves_posed_geometry_and_removes_only_fingers(self):
        rig = self.rig()
        source = self.root / "rig" / "rigged.blend"
        original_bytes = source.read_bytes()
        pose = {"version": 2, "detail": "basic", "left": [60, -20, 40], "right": [0, 0, 0],
                "fingers": {"left": {"thumb": .6, "index": .8, "fingers": 1, "opposition": .4},
                            "right": {"thumb": .2, "index": .2, "fingers": .2, "opposition": .1}}}
        for name, rotation in finger_corrections(pose, rig).items():
            rig.pose.bones[name].rotation_mode = "QUATERNION"
            rig.pose.bones[name].rotation_quaternion = rotation
        bpy.context.view_layer.update()
        expected = {o.name: [v.co.copy() for v in o.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices] for o in character.meshes()}
        output = self.root / "grip"
        character.bake_grip({"input": str(source), "output": str(output), "handPose": pose})
        self.assertEqual(source.read_bytes(), original_bytes)
        bpy.ops.wm.open_mainfile(filepath=str(output / "rigged.blend"))
        rig = bpy.data.objects["StudioHumanoid"]
        self.assertEqual(set(rig.data.bones.keys()), {name for name, _, _ in character.BONES})
        for obj in character.meshes():
            self.assertEqual(len(obj.data.vertices), len(expected[obj.name]))
            for vertex in obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices:
                self.assertLess((vertex.co - expected[obj.name][vertex.index]).length, 1e-5)
        report = character.validate_skin(rig, character.meshes())
        self.assertEqual(report["weightedVertices"], report["vertices"])
        rig.pose.bones["LeftHand"].rotation_mode = "XYZ"
        rig.pose.bones["LeftHand"].rotation_euler.x = .5
        bpy.context.view_layer.update()
        moved = max((v.co - expected[o.name][v.index]).length for o in character.meshes()
                    for v in o.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices)
        self.assertGreater(moved, .01)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=str(output / "fixed-grip.fbx"), ignore_leaf_bones=False)
        imported = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
        self.assertEqual(len(imported.data.bones), 22)
        character.validate_skin(imported, character.meshes())
        if os.environ.get("STUDIO_RIG_TEST_OUTPUT"):
            shutil.copyfile(output / "rigged.glb", Path(os.environ["STUDIO_RIG_TEST_OUTPUT"]) / "fixed-grip.glb")
