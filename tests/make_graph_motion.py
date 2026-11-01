"""Analytic graph harness only: obey real constraint files without loading an AI model."""
import json
import sys
from pathlib import Path
import numpy as np
import torch
from scipy.spatial.transform import Rotation, Slerp

request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
sys.path.insert(0, request["kimodo"])
from kimodo.skeleton import SOMASkeleton77
from kimodo.constraints import load_constraints_lst
from kimodo.exports.bvh import save_motion_bvh

skel = SOMASkeleton77()
frames = int(request["seconds"] * 30)
names = list(skel.bone_order_names)
constraints = load_constraints_lst(request["constraints"], skel) if request["constraints"] else []
root = np.array([0., float(-skel.neutral_joints[:, 1].min()), 0.], dtype=np.float32)
local = np.tile(np.eye(3, dtype=np.float32), (frames, 77, 1, 1))
is_transition = request["stage"] == "transition"
if constraints:
    constraint = constraints[0]
    root = constraint.global_joints_positions[0, skel.root_idx].numpy().copy()
    initial = skel.global_rots_to_local_rots(constraint.global_joints_rots[:1]).numpy()[0]
    local[:] = initial
elif "crouched down low" in request["prompt"].lower():
    root[1] -= 0.35
    for side in ("Left", "Right"):
        for bone, angle in [("Leg", -0.75), ("Shin", 1.4), ("Foot", -0.65)]:
            local[:, names.index(side + bone)] = Rotation.from_euler("x", angle).as_matrix()
roots = np.tile(root, (frames, 1))
if is_transition:
    assert constraints and constraint.frame_indices.tolist() == [0, frames - 1]
    global_rotations = np.empty_like(local)
    for joint in range(77):
        rotations = Rotation.from_matrix(constraint.global_joints_rots[:, joint].numpy())
        global_rotations[:, joint] = Slerp([0, frames - 1], rotations)(np.arange(frames)).as_matrix()
    roots = np.linspace(constraint.global_joints_positions[0, skel.root_idx], constraint.global_joints_positions[-1, skel.root_idx], frames)
    local = skel.global_rots_to_local_rots(torch.tensor(global_rotations)).numpy()
else:
    for frame in range(frames):
        angle = 0.2 * np.sin(frame / (frames - 1) * np.pi * 2)
        i = names.index("RightForeArm")
        local[frame, i] = local[frame, i] @ Rotation.from_euler("z", angle).as_matrix()
global_rots, joints, _ = skel.fk(torch.tensor(local, dtype=torch.float32), torch.tensor(roots, dtype=torch.float32))
if constraints:
    for index, frame in enumerate(constraint.frame_indices.tolist()):
        assert frame < frames
        global_rots[frame] = constraint.global_joints_rots[index]
        joints[frame] = constraint.global_joints_positions[index]
path = Path(request["output"])
np.savez(path, global_rot_mats=global_rots.numpy(), posed_joints=joints.numpy())
save_motion_bvh(str(path.with_suffix(".bvh")), skel.global_rots_to_local_rots(global_rots), joints[:, skel.root_idx], skeleton=skel, fps=30)
path.with_suffix(".fixture.json").write_text(json.dumps({
    "source": "ANALYTIC HARNESS ONLY - NOT AI GENERATION", "frames": frames,
    "startHeight": float(joints[0, skel.root_idx, 1]), "endHeight": float(joints[-1, skel.root_idx, 1])
}), encoding="utf-8")
