"""Isolated Blender CPU backend. No pip packages or Comfy environment mutations."""
import json
import math
import sys
import traceback
from statistics import median
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector
from mathutils.kdtree import KDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from skin_weights import repair_weights
from hand_rig import CHAINS, hand_definitions, build_hand_bones, skin_hands, finger_corrections, sample_hand_pose, validate_timeline

C = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
BONES = [
    ("Hips", "Spine1", None), ("Spine1", "Spine2", "Hips"),
    ("Spine2", "Chest", "Spine1"), ("Chest", "Neck1", "Spine2"),
    ("Neck1", "Head", "Chest"), ("Head", "HeadEnd", "Neck1"),
]
for side in ("Left", "Right"):
    BONES += [
        (side + "Shoulder", side + "Arm", "Chest"),
        (side + "Arm", side + "ForeArm", side + "Shoulder"),
        (side + "ForeArm", side + "Hand", side + "Arm"),
        (side + "Hand", side + "HandEnd", side + "ForeArm"),
        (side + "Leg", side + "Shin", "Hips"),
        (side + "Shin", side + "Foot", side + "Leg"),
        (side + "Foot", side + "ToeBase", side + "Shin"),
        (side + "ToeBase", side + "ToeEnd", side + "Foot"),
    ]


def emit(stage, message, progress=0, code=None):
    print("STUDIO:" + json.dumps({"stage": stage, "message": message, "progress": progress, "code": code}), flush=True)


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")


def meshes():
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and len(o.data.vertices)]


def bounds(objects):
    points = [o.matrix_world @ v.co for o in objects for v in o.data.vertices]
    if not points:
        raise ValueError("FBX contains no mesh vertices. Import a humanoid character, not a skeleton-only FBX.")
    return Vector([min(p[i] for p in points) for i in range(3)]), Vector([max(p[i] for p in points) for i in range(3)])


def normalize(objects, rotation=None):
    worlds = {obj.name: obj.matrix_world.copy() for obj in objects}
    for obj in objects:
        world = worlds[obj.name]
        obj.parent = None
        obj.data.transform(world)
        obj.matrix_world = Matrix.Identity(4)
        if rotation is not None:
            obj.data.transform(rotation.to_4x4())
    lo, hi = bounds(objects)
    height = hi.z - lo.z
    if not math.isfinite(height) or height < 1e-6:
        raise ValueError("Character has zero height or non-finite coordinates. Check the FBX geometry.")
    transform = Matrix.Scale(2 / height, 4) @ Matrix.Translation(Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)))
    for obj in objects:
        obj.data.transform(transform)
        obj.data.update()


def export_glb(path, animated):
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=False,
        export_animations=animated, export_skins=True, export_yup=True,
        export_animation_mode="SCENE", export_frame_range=True, export_force_sampling=True,
        export_anim_single_armature=True, export_influence_nb=4,
        export_anim_slide_to_zero=True,
    )


def suggest_rotation(objects):
    points = [obj.matrix_world @ vertex.co for obj in objects for vertex in obj.data.vertices]
    shoulders = [p for p in points if 1.24 < p.z < 1.66]
    if not shoulders:
        return [0, 0, 0], "Could not estimate T-pose axes. Check orientation in front and side views."
    span = [max(p[i] for p in shoulders) - min(p[i] for p in shoulders) for i in (0, 1)]
    yaw = 90 if span[1] > span[0] * 1.25 else 0
    depth = (lambda p: -p.x) if yaw == 90 else (lambda p: -p.y)
    feet = [depth(p) for p in points if 0.025 < p.z < 0.13]
    ankles = [depth(p) for p in points if 0.17 < p.z < 0.32]
    uncertain = False
    if feet and ankles:
        center = median(ankles)
        forward, backward = max(feet) - center, center - min(feet)
        if backward - forward > 0.035:
            yaw = (yaw + 360) % 360 - 180
        uncertain = abs(forward - backward) <= 0.035
    else:
        uncertain = True
    note = "T-pose orientation estimated from shoulder span and feet. Verify the face is toward the camera."
    if uncertain:
        note = "Front/back orientation is ambiguous from this mesh. Confirm the facing direction before rigging."
    return [0, yaw, 0], note


def import_character(req):
    emit("importing", "Reading character geometry and materials", 15)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if Path(req["input"]).suffix.lower() == ".glb":
        bpy.ops.import_scene.gltf(filepath=req["input"])
    else:
        bpy.ops.import_scene.fbx(filepath=req["input"], use_anim=False, ignore_leaf_bones=True)
    warnings = []
    if any(o.type == "ARMATURE" for o in bpy.context.scene.objects):
        warnings.append("Existing armature is replaced by the studio humanoid rig. Original FBX is preserved.")
        for obj in bpy.context.scene.objects:
            if obj.type == "ARMATURE":
                obj.data.pose_position = "REST"
    bpy.context.view_layer.update()
    objects = meshes()
    if sum(len(o.data.vertices) for o in objects) > 2_000_000:
        raise ValueError("Character exceeds 2 million vertices. Decimate a copy before automatic skinning.")
    for obj in objects:
        if obj.data.shape_keys:
            warnings.append(f"{obj.name}: shape keys are flattened in the working copy.")
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        data = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=bpy.context.evaluated_depsgraph_get())
        obj.modifiers.clear()
        obj.data = data
        obj.vertex_groups.clear()
        obj.animation_data_clear()
    normalize(objects)
    rotation, orientation_note = suggest_rotation(objects)
    warnings.append(orientation_note)
    for obj in list(bpy.context.scene.objects):
        if obj not in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
    missing = [im.name for im in bpy.data.images if im.source == "FILE" and not im.packed_file and not Path(bpy.path.abspath(im.filepath)).is_file()]
    if missing:
        warnings.append("Missing textures: " + ", ".join(missing[:8]) + ". Place the FBX texture folder beside the original and reimport.")
    for image in bpy.data.images:
        if image.source == "FILE" and not image.packed_file and Path(bpy.path.abspath(image.filepath)).is_file():
            image.pack()
    emit("importing", "Preparing character preview", 65)
    out = Path(req["output"])
    out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "character.blend"))
    export_glb(out / "preview.glb", False)
    report = {"vertices": sum(len(o.data.vertices) for o in objects), "meshes": len(objects), "warnings": warnings, "suggestedRotation": rotation}
    write_json(out / "import-report.json", report)
    emit("importing", "Character imported. Fit the humanoid landmarks before rigging.", 100)


class UnweightedSkinError(ValueError):
    pass


def validate_skin(rig, objects):
    total, unweighted = 0, 0
    influenced = set()
    for obj in objects:
        if not any(m.type == "ARMATURE" and m.object == rig for m in obj.modifiers):
            raise ValueError(f"{obj.name} has no skinning modifier.")
        groups = {g.index: g.name for g in obj.vertex_groups if g.name in rig.data.bones and rig.data.bones[g.name].use_deform}
        for vertex in obj.data.vertices:
            if any(not math.isfinite(g.weight) or g.weight < 0 for g in vertex.groups if g.group in groups):
                raise ValueError(f"{obj.name} contains invalid skin weights. Rebuild the rig.")
            weights = [(groups[g.group], g.weight) for g in vertex.groups if g.group in groups and g.weight > 1e-6]
            total += 1
            if not weights:
                unweighted += 1
            influenced.update(name for name, _ in weights)
    if not total or unweighted:
        raise UnweightedSkinError(
            f"Automatic skinning left {unweighted:,} of {total:,} vertices unweighted. "
            "No successful character result was saved. Your fitted points are preserved. "
            "Adjust them and rebuild, or choose Accept points + fallback skinning. "
            "If fallback still fails or bends incorrectly, separate touching limbs and repair "
            "non-manifold/intersecting geometry in Blender before reimporting."
        )
    required = {"Hips", "Head", "LeftArm", "RightArm", "LeftLeg", "RightLeg"}
    if required - influenced:
        raise ValueError("No mesh influence for required bones: " + ", ".join(sorted(required - influenced)) + ". Refit the rig to a full humanoid mesh.")
    return {"vertices": total, "weightedVertices": total - unweighted, "deformingBones": len(influenced), "bones": len(rig.data.bones)}


SEAM_WELD_DISTANCE = 1e-5


def welded_heat_proxy(obj):
    """Return a seam-welded copy and its original-to-copy vertex map, or None when nothing coincides."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=SEAM_WELD_DISTANCE)
    if len(bm.verts) == before:
        bm.free()
        return None
    mesh = bpy.data.meshes.new(obj.name + "StudioHeatProxy")
    bm.to_mesh(mesh)
    bm.free()
    proxy = bpy.data.objects.new(mesh.name, mesh)
    proxy.matrix_world = obj.matrix_world.copy()
    bpy.context.collection.objects.link(proxy)
    tree = KDTree(len(mesh.vertices))
    for vertex in mesh.vertices:
        tree.insert(vertex.co, vertex.index)
    tree.balance()
    mapping = []
    for vertex in obj.data.vertices:
        _, index, distance = tree.find(vertex.co)
        if index is None or distance > SEAM_WELD_DISTANCE * 2:
            raise ValueError(f"Could not map {obj.name} to its welded skinning copy. Repair the mesh before rigging.")
        mapping.append(index)
    return proxy, mapping, before - len(mesh.vertices)


def copy_proxy_weights(proxy, obj, mapping):
    names = {group.index: group.name for group in proxy.vertex_groups}
    targets = {name: obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name) for name in names.values()}
    weights = [[(names[g.group], g.weight) for g in vertex.groups if g.group in names and g.weight > 1e-6]
               for vertex in proxy.data.vertices]
    for index, source in enumerate(mapping):
        for name, weight in weights[source]:
            targets[name].add([index], weight, "REPLACE")


HEAT_RETRY_LIMIT = 64


def unweighted_pieces(obj, deform):
    """Connected pieces of obj with no deforming weight and at least one face, largest first."""
    mesh = obj.data
    groups = {g.index for g in obj.vertex_groups if g.name in deform}
    weighted = [any(g.group in groups and g.weight > 1e-6 for g in v.groups) for v in mesh.vertices]
    if all(weighted):
        return []
    parent = list(range(len(weighted)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for edge in mesh.edges:
        a, b = find(edge.vertices[0]), find(edge.vertices[1])
        if a != b:
            parent[a] = b
    roots = [find(i) for i in range(len(parent))]
    weighted_roots = {roots[i] for i, done in enumerate(weighted) if done}
    pieces = {}
    for polygon in mesh.polygons:
        root = roots[polygon.vertices[0]]
        if root not in weighted_roots:
            pieces.setdefault(root, ([], []))[1].append(tuple(polygon.vertices))
    for i, root in enumerate(roots):
        if root in pieces:
            pieces[root][0].append(i)
    return sorted(pieces.values(), key=lambda piece: len(piece[0]), reverse=True)


def solve_piece_heat(rig, obj, vertices, faces):
    """Bone heat on one isolated piece, so other pieces cannot occlude it or make the shared solve singular."""
    local = {index: k for k, index in enumerate(vertices)}
    mesh = bpy.data.meshes.new(obj.name + "StudioHeatPiece")
    mesh.from_pydata([tuple(obj.data.vertices[i].co) for i in vertices], [], [[local[i] for i in face] for face in faces])
    piece = bpy.data.objects.new(mesh.name, mesh)
    piece.matrix_world = obj.matrix_world.copy()
    bpy.context.collection.objects.link(piece)
    try:
        bpy.ops.object.select_all(action="DESELECT")
        piece.select_set(True)
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        try:
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        except RuntimeError as exc:
            if "bone heat weighting: failed to find solution" not in str(exc).lower():
                raise
            return 0
        names = {group.index: group.name for group in piece.vertex_groups}
        solved = 0
        for vertex in mesh.vertices:
            weights = [(names[g.group], g.weight) for g in vertex.groups if g.group in names and g.weight > 1e-6]
            if not weights:
                continue
            solved += 1
            for name, weight in weights:
                (obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)).add([vertices[vertex.index]], weight, "REPLACE")
        return solved
    finally:
        bpy.data.objects.remove(piece, do_unlink=True)
        bpy.data.meshes.remove(mesh)


def retry_piece_heat(rig, targets):
    deform = {bone.name for bone in rig.data.bones if bone.use_deform}
    report = {"pieces": 0, "solvedPieces": 0, "vertices": 0, "skippedPieces": 0}
    for target in targets:
        pieces = unweighted_pieces(target, deform)
        report["skippedPieces"] += max(0, len(pieces) - HEAT_RETRY_LIMIT)
        for vertices, faces in pieces[:HEAT_RETRY_LIMIT]:
            report["pieces"] += 1
            solved = solve_piece_heat(rig, target, vertices, faces)
            report["solvedPieces"] += solved > 0
            report["vertices"] += solved
    return report


def repair_skin(rig, objects, fallback):
    connected, proximity = 0, 0
    bones = [(bone.name, tuple(rig.matrix_world @ bone.head_local), tuple(rig.matrix_world @ bone.tail_local))
             for bone in rig.data.bones if bone.use_deform] if fallback else []
    for obj in objects:
        groups = {g.index: g.name for g in obj.vertex_groups if g.name in rig.data.bones and rig.data.bones[g.name].use_deform}
        if any(not math.isfinite(g.weight) or g.weight < 0 for vertex in obj.data.vertices for g in vertex.groups if g.group in groups):
            raise ValueError(f"{obj.name} contains invalid skin weights. Rebuild the rig.")
        weights = [{groups[g.group]: g.weight for g in vertex.groups if g.group in groups and g.weight > 1e-6}
                   for vertex in obj.data.vertices]
        updates, repaired, approximated = repair_weights(
            [tuple(obj.matrix_world @ v.co) for v in obj.data.vertices],
            [tuple(edge.vertices) for edge in obj.data.edges], weights, bones)
        for vertex, influence in updates.items():
            for name, weight in influence.items():
                group = obj.vertex_groups.get(name)
                if group is None:
                    group = obj.vertex_groups.new(name=name)
                group.add([vertex], weight, "REPLACE")
        connected += repaired
        proximity += approximated
    return {"connectedVertices": connected, "fallbackVertices": proximity}


def rig_character(req):
    skinning = req.get("skinning", "automatic")
    if skinning not in ("automatic", "fallback"):
        raise ValueError("Unknown skinning mode.")
    bpy.ops.wm.open_mainfile(filepath=req["input"])
    setup = req["setup"]
    xyz = [math.radians(float(n)) for n in setup["rotation"]]
    r = Matrix.Rotation(xyz[0], 3, "X") @ Matrix.Rotation(xyz[1], 3, "Y") @ Matrix.Rotation(xyz[2], 3, "Z")
    objects = meshes()
    normalize(objects, C @ r @ C.inverted())
    points = {name: C @ Vector(pos) for name, pos in setup["landmarks"].items()}
    hands = hand_definitions(setup, C)
    emit("rigging", "Building fitted humanoid bones", 15)
    data = bpy.data.armatures.new("StudioHumanoid")
    rig = bpy.data.objects.new("StudioHumanoid", data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, tail, parent in BONES:
        bone = data.edit_bones.new(name)
        bone.head, bone.tail = points[name], points[tail]
        if bone.length < 0.015:
            raise ValueError(f"{name} is too short. Separate its landmarks by at least 1.5cm.")
        if parent:
            bone.parent = data.edit_bones[parent]
            bone.use_connect = (bone.head - bone.parent.tail).length < 1e-5
        bone.align_roll(Vector((0, -1, 0)))
    build_hand_bones(data, hands)
    bpy.ops.object.mode_set(mode="OBJECT")
    emit("rigging", "Solving Blender bone-heat skin weights (CPU)", 35)
    warnings = []
    # glTF and generated meshes split vertices along UV seams; those open islands make bone heat fail,
    # so solve on welded copies and map weights back without changing the character geometry.
    proxies = {obj.name: welded for obj in objects if (welded := welded_heat_proxy(obj))}
    seam_weld = {"meshes": len(proxies), "mergedVertices": sum(merged for _, _, merged in proxies.values())}
    bpy.ops.object.select_all(action="DESELECT")
    targets = [proxies[obj.name][0] if obj.name in proxies else obj for obj in objects]
    for target in targets:
        target.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    try:
        try:
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        except RuntimeError as exc:
            if "bone heat weighting: failed to find solution" not in str(exc).lower():
                raise
            warnings.append("Blender bone-heat weighting failed for the combined mesh; unweighted pieces were retried separately before missing-weight recovery.")
            emit("rigging", warnings[-1], 40)
        # One occluded or detached piece leaves the combined solve with no weights there, or makes it singular
        # for the whole object. Solving such pieces alone often recovers them without approximate weights.
        emit("rigging", "Checking for mesh pieces that bone heat could not weight", 42)
        heat_retry = retry_piece_heat(rig, targets)
        if heat_retry["solvedPieces"]:
            warnings.append(f"Bone heat was solved separately for {heat_retry['solvedPieces']:,} mesh piece(s) ({heat_retry['vertices']:,} vertices) that the combined solve could not weight. Check that separate pieces bend with the expected bones.")
        if heat_retry["skippedPieces"]:
            warnings.append(f"{heat_retry['skippedPieces']:,} further unweighted mesh piece(s) were not re-solved individually; missing-weight recovery handles them.")
        for obj in objects:
            if obj.name in proxies:
                proxy, mapping, _ = proxies[obj.name]
                copy_proxy_weights(proxy, obj, mapping)
    finally:
        for proxy, _, _ in proxies.values():
            mesh = proxy.data
            bpy.data.objects.remove(proxy, do_unlink=True)
            bpy.data.meshes.remove(mesh)
    for obj in objects:
        if obj.parent != rig:
            world = obj.matrix_world.copy()
            obj.parent = rig
            obj.matrix_world = world
        if not any(m.type == "ARMATURE" and m.object == rig for m in obj.modifiers):
            modifier = obj.modifiers.new(name="StudioHumanoid", type="ARMATURE")
            modifier.object = rig
    bpy.context.view_layer.update()
    emit("rigging", "Repairing missing skin weights along connected mesh surfaces", 50)
    repair = repair_skin(rig, objects, skinning == "fallback")
    if repair["connectedVertices"]:
        warnings.append(f"Repaired {repair['connectedVertices']:,} unweighted vertices from connected mesh surfaces. Inspect joint bending; complete weights do not guarantee good deformation.")
    if repair["fallbackVertices"]:
        warnings.append(f"Approximate fallback weights assigned to {repair['fallbackVertices']:,} vertices using your fitted bones. Separate pieces or touching limbs can bend incorrectly. Review deformation before using or exporting this character.")
    hand_weights = skin_hands(rig, objects, hands)
    for obj in objects:
        bpy.context.view_layer.objects.active = obj
        if not obj.vertex_groups:
            continue
        bpy.ops.object.vertex_group_limit_total(limit=4)
        bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    report = validate_skin(rig, objects)
    report["skinning"] = skinning
    report["repair"] = repair
    report["seamWeld"] = seam_weld
    report["heatRetry"] = heat_retry
    report["hands"] = hand_weights
    report["warnings"] = warnings + [
        "Guided three-chain hands use coarse region weights; inspect thumb/index separation and palm bend. Fused geometry is not repaired." if hands else "Wrist-only body rig: finger articulation is not enabled.",
        "Facial controls and cloth simulation are not generated.",
        "Inspect joint placement and bending. Automatic weights may need artist cleanup.",
    ]
    rig["studio_skinning_warnings"] = json.dumps(report["warnings"])
    emit("rigging", "Validating skin and saving the actual rigged mesh", 80)
    out = Path(req["output"])
    out.mkdir(parents=True, exist_ok=True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "rigged.blend"))
    export_glb(out / "rigged.glb", False)
    write_json(out / "rig-report.json", report)
    emit("rigging", f"Skin validated: {report['weightedVertices']:,} weighted vertices", 100)


def animate_character(req):
    bpy.ops.wm.open_mainfile(filepath=req["input"])
    rig = bpy.data.objects.get("StudioHumanoid")
    if rig is None or rig.type != "ARMATURE":
        raise ValueError("Validated StudioHumanoid rig is missing. Run the rig stage again.")
    report = validate_skin(rig, meshes())
    motion = json.loads(Path(req["motion"]).read_text(encoding="utf-8"))
    names = {name: i for i, name in enumerate(motion["joint_names"])}
    required = {name for name, _, _ in BONES}
    if required - names.keys():
        raise ValueError("Motion is not a compatible SOMA humanoid: missing " + ", ".join(sorted(required - names.keys())))
    rotations = motion["global_rot_mats"]
    roots = motion["root_positions"]
    neutral = [C @ Vector(v) for v in motion["neutral_joints"]]
    frames = len(rotations)
    if frames < 2 or len(roots) != frames:
        raise ValueError("Motion must contain at least two complete frames.")
    source_height = max(v.z for v in neutral) - min(v.z for v in neutral)
    scale = 2.0 / source_height
    fps = float(motion["fps"])
    bpy.context.scene.render.fps = round(fps)
    bpy.context.scene.render.fps_base = round(fps) / fps
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = frames
    canonical = {}
    rest = {name: rig.data.bones[name].matrix_local.to_quaternion() for name, _, _ in BONES}
    timeline = validate_timeline(req.get("handTimeline", [{"start": 0, "end": frames - 1, "pose": req.get("handPose")}]), frames)
    preceding_hand = None
    for span in timeline:
        hand_corrections(span["pose"], rest)
        endpoints = []
        for time in (0, 1):
            endpoint = sample_hand_pose(span["pose"], time)
            finger_corrections(endpoint, rig)
            endpoints.append([value for side in ("left", "right") for value in
                              ((endpoint or {}).get(side, [0, 0, 0]) +
                               [((endpoint or {}).get("fingers", {}).get(side, {}).get(control, 0)) for control in ("thumb", "index", "fingers", "opposition")])])
        if preceding_hand and any(abs(a - b) > 1e-6 for a, b in zip(preceding_hand, endpoints[0])):
            raise ValueError("Hand poses jump at a path seam. Match the endpoint keys or add a transition.")
        preceding_hand = endpoints[1]
    for name, tail, _ in BONES:
        source_tail = tail
        if tail.endswith("HandEnd"):
            source_tail = tail.replace("HandEnd", "HandMiddle1")
        target_dir = rig.data.bones[name].tail_local - rig.data.bones[name].head_local
        source_dir = neutral[names[source_tail]] - neutral[names[name]]
        canonical[name] = target_dir.rotation_difference(source_dir) @ rest[name]
    first_root = C @ Vector(motion.get("root_origin", roots[0]))
    root_rest = rig.data.bones["Hips"].head_local.copy()
    source_pelvis = neutral[names["Hips"]].z - min(v.z for v in neutral)
    previous = {}
    emit("retargeting", f"Retargeting {frames} frames onto skinned character", 12)
    for frame in range(frames):
        span = next(span for span in reversed(timeline) if span["start"] <= frame)
        pose = sample_hand_pose(span["pose"], (frame - span["start"]) / (span["end"] - span["start"]))
        hand_offsets = hand_corrections(pose, rest)
        fingers = finger_corrections(pose, rig)
        desired = {}
        for name, _, parent in BONES:
            source = Matrix(rotations[frame][names[name]])
            desired[name] = (C @ source @ C.inverted()).to_quaternion() @ canonical[name]
            if parent:
                local_rest = rest[parent].inverted() @ rest[name]
                q = local_rest.inverted() @ desired[parent].inverted() @ desired[name]
            else:
                q = rest[name].inverted() @ desired[name]
            if name in hand_offsets:
                q = q @ hand_offsets[name]
            if name in previous and q.dot(previous[name]) < 0:
                q.negate()
            previous[name] = q.copy()
            pb = rig.pose.bones[name]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = q
            pb.keyframe_insert(data_path="rotation_quaternion", frame=frame + 1, group=name)
        for name, rotation in fingers.items():
            pb = rig.pose.bones[name]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = rotation
            pb.keyframe_insert(data_path="rotation_quaternion", frame=frame + 1, group=name)
        source_root = C @ Vector(roots[frame])
        # Preserve target proportions; horizontal trajectory starts at the viewport origin.
        pos = root_rest.copy()
        if not req.get("inPlace", False):
            pos.x += (source_root.x - first_root.x) * scale
            pos.y += (source_root.y - first_root.y) * scale
        pos.z += (source_root.z - source_pelvis) * scale
        rig.pose.bones["Hips"].location = rest["Hips"].inverted() @ (pos - root_rest)
        rig.pose.bones["Hips"].keyframe_insert(data_path="location", frame=frame + 1, group="Hips")
        if frame % 20 == 0:
            emit("retargeting", f"Baking frame {frame + 1}/{frames}", 15 + 55 * frame / frames)
    action = rig.animation_data.action
    action.name = "Kimodo character motion"
    # Blender 4.5 uses layered actions.
    for layer in action.layers:
        for strip in layer.strips:
            for slot in action.slots:
                bag = strip.channelbag(slot)
                if bag:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:
                            key.interpolation = "LINEAR"
    samples = {}
    sample_frames = sorted(set([1, max(1, frames // 3), max(1, frames * 2 // 3), frames]))
    for frame in sample_frames:
        bpy.context.scene.frame_set(frame)
        deps = bpy.context.evaluated_depsgraph_get()
        samples[frame] = []
        for obj in meshes():
            evaluated = obj.evaluated_get(deps)
            mesh = evaluated.to_mesh()
            stride = max(1, len(mesh.vertices) // 1000)
            samples[frame].extend([tuple(evaluated.matrix_world @ mesh.vertices[i].co) for i in range(0, len(mesh.vertices), stride)])
            evaluated.to_mesh_clear()
    first = samples[sample_frames[0]]
    displacement = max((Vector(a) - Vector(b)).length for frame in sample_frames[1:] for a, b in zip(first, samples[frame]))
    if not math.isfinite(displacement) or (displacement < 0.00001 and not req.get("allowStatic", False)):
        raise ValueError("Retargeted mesh did not move across sampled frames. Refusing an animated-character success result.")
    out = Path(req["output"])
    prefix = req.get("exportPrefix", "animated")
    if prefix not in ("animated", "clip", "transition"):
        raise ValueError("Invalid character export prefix.")
    out.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.frame_set(1)
    emit("retargeting", "Exporting skinned animated GLB and FBX", 82)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / f"{prefix}.blend"))
    export_glb(out / f"{prefix}.glb", True)
    bpy.ops.export_scene.fbx(
        filepath=str(out / f"{prefix}.fbx"), use_selection=False, object_types={"ARMATURE", "MESH"},
        add_leaf_bones=False, bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False,
        bake_anim_simplify_factor=0.0, path_mode="COPY", embed_textures=True, axis_forward="-Z", axis_up="Y",
    )
    report.update({
        "frames": frames, "fps": fps, "duration": (frames - 1) / fps,
        "sampledMeshDisplacement": displacement,
        "staticHold": displacement < 0.00001,
        "handPose": req.get("handPose"),
        "handTimeline": timeline,
        "warnings": json.loads(rig.get("studio_skinning_warnings", "[]")) + ["Foot contact cleanup is not installed; foot sliding can require manual cleanup.", "Finger poses are local controls, not learned finger motion. Facial animation is not retargeted."],
    })
    write_json(out / ("animation-report.json" if prefix == "animated" else f"{prefix}-report.json"), report)
    emit("retargeting", "Animated character exported and mesh deformation verified", 100)


def hand_corrections(pose, rest):
    if pose is None:
        return {}
    if not isinstance(pose, dict) or type(pose.get("version")) is not int or not (
        pose["version"] == 1 and pose.get("detail") == "wrist" and set(pose) == {"version", "detail", "left", "right"} or
        pose["version"] == 2 and pose.get("detail") == "basic" and {"version", "detail", "left", "right", "fingers"} <= set(pose) <= {"version", "detail", "left", "right", "fingers", "keyframes"}
    ):
        raise ValueError("Unsupported hand pose. Expected wrist-only or Basic three-chain settings.")
    result = {}
    for side in ("left", "right"):
        angles = pose[side]
        if not isinstance(angles, list) or len(angles) != 3 or any(type(a) not in (int, float) or not math.isfinite(a) or abs(a) > 180 for a in angles):
            raise ValueError("Hand rotations must be three finite angles between -180 and 180 degrees.")
        name = side.capitalize() + "Hand"
        if name not in rest:
            raise ValueError(f"{name} is missing from this rig. Rebuild the humanoid rig.")
        xyz = [math.radians(a) for a in angles]
        offset = Matrix.Rotation(xyz[0], 3, "X") @ Matrix.Rotation(xyz[1], 3, "Y") @ Matrix.Rotation(xyz[2], 3, "Z")
        offset = (C @ offset @ C.inverted()).to_quaternion()
        result[name] = rest[name].inverted() @ offset @ rest[name]
    return result


def bake_grip(req):
    bpy.ops.wm.open_mainfile(filepath=req["input"])
    rig = bpy.data.objects.get("StudioHumanoid")
    if rig is None or rig.type != "ARMATURE":
        raise ValueError("Build a validated hand rig before baking a fixed grip.")
    objects = meshes()
    validate_skin(rig, objects)
    pose = req["handPose"]
    hand_corrections(pose, {name: rig.data.bones[name].matrix_local.to_quaternion() for name, _, _ in BONES})
    if pose.get("keyframes") is not None:
        raise ValueError("Disable hand animation and save a static pose before baking a fixed grip.")
    rotations = finger_corrections(pose, rig)
    if not rotations:
        raise ValueError("The character has no fitted finger chains to bake.")
    rig.animation_data_clear()
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    for name, rotation in rotations.items():
        rig.pose.bones[name].rotation_mode = "QUATERNION"
        rig.pose.bones[name].rotation_quaternion = rotation
    bpy.context.view_layer.update()
    emit("rigging", "Baking finger geometry into a new wrist-only variation", 30)
    collapse = {f"{side}{chain}{i + 1}": side + "Hand" for side in ("Left", "Right")
                for chain, _, count, _ in CHAINS for i in range(count)}
    for obj in objects:
        groups = {g.index: g.name for g in obj.vertex_groups}
        weights = []
        for vertex in obj.data.vertices:
            values = {}
            for group in vertex.groups:
                name = collapse.get(groups[group.group], groups[group.group])
                values[name] = values.get(name, 0) + group.weight
            weights.append(values)
        deps = bpy.context.evaluated_depsgraph_get()
        data = bpy.data.meshes.new_from_object(obj.evaluated_get(deps), preserve_all_data_layers=True, depsgraph=deps)
        if len(data.vertices) != len(weights):
            raise ValueError("Grip baking changed topology. Refusing to copy incompatible skin weights.")
        obj.modifiers.clear()
        obj.data = data
        obj.vertex_groups.clear()
        targets = {name: obj.vertex_groups.new(name=name) for name, _, _ in BONES}
        for index, values in enumerate(weights):
            for name, weight in values.items():
                if name in targets and weight > 0:
                    targets[name].add([index], weight, "REPLACE")
        modifier = obj.modifiers.new(name="StudioHumanoid", type="ARMATURE")
        modifier.object = rig
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name in collapse:
        if name in rig.data.edit_bones:
            rig.data.edit_bones.remove(rig.data.edit_bones[name])
    bpy.ops.object.mode_set(mode="OBJECT")
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    report = validate_skin(rig, objects)
    report.update({"meshes": len(objects), "handPose": pose,
                   "handEnds": {side: list(C.inverted() @ rig.data.bones[side.capitalize() + "Hand"].tail_local) for side in ("left", "right")},
                   "warnings": ["Fixed finger shape baked from a guided hand pose. Wrist offsets remain separate; inspect collisions and skin deformation."]})
    out = Path(req["output"])
    out.mkdir(parents=True, exist_ok=True)
    rig["studio_skinning_warnings"] = json.dumps(report["warnings"])
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "rigged.blend"))
    export_glb(out / "rigged.glb", False)
    bpy.ops.export_scene.fbx(filepath=str(out / "fixed-grip.fbx"), use_selection=False, object_types={"ARMATURE", "MESH"},
                             add_leaf_bones=False, bake_anim=False, path_mode="COPY", embed_textures=True, axis_forward="-Z", axis_up="Y")
    for obj in objects:
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
        obj.modifiers.clear()
        obj.vertex_groups.clear()
    bpy.data.objects.remove(rig, do_unlink=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "character.blend"))
    export_glb(out / "preview.glb", False)
    write_json(out / "grip-report.json", report)
    emit("rigging", "Fixed-grip variation validated; original character preserved", 100)


if __name__ == "__main__":
    try:
        request = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text(encoding="utf-8"))
        {"import": import_character, "rig": rig_character, "animate": animate_character, "bake-grip": bake_grip}[request["command"]](request)
    except Exception as exc:
        emit("failed", str(exc), code="unweighted-skin" if isinstance(exc, UnweightedSkinError) else None)
        traceback.print_exc()
        sys.exit(1)
