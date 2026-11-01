"""Analytic wave fixture, NOT text-generated motion. No model/network access."""
import sys
import json
from pathlib import Path
import numpy as np

sys.path.insert(0, sys.argv[1])
from kimodo.skeleton import SOMASkeleton77

skel = SOMASkeleton77()
neutral = skel.neutral_joints.cpu().numpy()
names = list(skel.bone_order_names)
rotations = np.tile(np.eye(3), (60, 77, 1, 1))
joints = np.tile(neutral, (60, 1, 1))
pelvis = -neutral[:, 1].min()
for frame in range(60):
    for index, name in enumerate(names):
        if name.startswith("RightForeArm") or name.startswith("RightHand"):
            angle = -0.5 - 0.45 * np.sin(frame / 59 * np.pi * 2)
        elif name.startswith("LeftArm") or name.startswith("LeftForeArm") or name.startswith("LeftHand"):
            angle = -0.5
        elif name == "RightArm":
            angle = 0.3
        else:
            angle = 0
        c, s = np.cos(angle), np.sin(angle)
        rotations[frame, index] = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    joints[frame, :, 1] += pelvis
np.savez(sys.argv[2], global_rot_mats=rotations, posed_joints=joints)
import torch
from kimodo.exports.bvh import save_motion_bvh
save_motion_bvh(
    str(Path(sys.argv[2]).with_suffix(".bvh")),
    skel.global_rots_to_local_rots(torch.tensor(rotations, dtype=torch.float32)),
    torch.tensor(joints[:, skel.root_idx], dtype=torch.float32), skeleton=skel, fps=30,
)
Path(sys.argv[2]).with_suffix(".fixture.json").write_text(json.dumps({
    "source": "Analytic wave test fixture; NOT Kimodo/ComfyUI text generation",
    "frames": 60, "fps": 30
}, indent=2))
print("Created labeled analytic motion fixture (no model used).")
