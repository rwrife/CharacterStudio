"""Reimport BOTH exported formats and verify actual skinned mesh motion."""
import json
import sys
from pathlib import Path
import bpy
from mathutils import Vector

directory = Path(sys.argv[sys.argv.index("--") + 1])
reports = []
for extension in ("glb", "fbx"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if extension == "glb":
        bpy.ops.import_scene.gltf(filepath=str(directory / "animated.glb"))
    else:
        bpy.ops.import_scene.fbx(filepath=str(directory / "animated.fbx"))
    rigs = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    helpers = {bone.custom_shape for rig in rigs for bone in rig.pose.bones if bone.custom_shape}
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj not in helpers]
    assert meshes and rigs, f"{extension}: missing mesh or skeleton"
    assert any(rig.animation_data and rig.animation_data.action for rig in rigs), f"{extension}: no armature animation"
    for mesh in meshes:
        assert any(mod.type == "ARMATURE" for mod in mesh.modifiers), f"{extension}: no skin modifier"
        assert all(sum(g.weight for g in v.groups) > 0.9 for v in mesh.data.vertices), f"{extension}: incomplete weights"
    evaluated_positions = []
    for frame in (1, 15, 40):
        bpy.context.scene.frame_set(frame)
        positions = []
        deps = bpy.context.evaluated_depsgraph_get()
        for mesh in meshes:
            obj = mesh.evaluated_get(deps)
            data = obj.to_mesh()
            positions.extend([tuple(obj.matrix_world @ data.vertices[i].co) for i in range(0, len(data.vertices), 191)])
            obj.to_mesh_clear()
        evaluated_positions.append(positions)
    delta = max((Vector(a) - Vector(b)).length for positions in evaluated_positions[1:] for a, b in zip(evaluated_positions[0], positions))
    assert delta > 0.02, f"{extension}: mesh not animated ({delta})"
    reports.append({"format": extension, "meshes": len(meshes), "bones": len(rigs[0].data.bones),
                    "vertices": sum(len(m.data.vertices) for m in meshes), "maxTestDisplacement": delta})
print("EXPORT_REIMPORT_VERIFIED:" + json.dumps(reports))
(directory / "reimport-verification.json").write_text(json.dumps(reports, indent=2), encoding="utf-8")
