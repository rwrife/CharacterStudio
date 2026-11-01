"""Read the original Kimodo NPZ without pickle; attach the actual SOMA rest pose."""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("--kimodo", required=True)
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--fps", type=float, required=True)
parser.add_argument("--origin")
args = parser.parse_args()
sys.path.insert(0, args.kimodo)
from kimodo.skeleton import SOMASkeleton77

skel = SOMASkeleton77()
with np.load(args.input, allow_pickle=False) as data:
    rotations = data["global_rot_mats"]
    joints = data["posed_joints"]
    if rotations.ndim != 4 or rotations.shape[1:] != (77, 3, 3):
        raise ValueError(f"Expected one SOMA-77 clip, got rotation shape {rotations.shape}.")
    if joints.shape != (rotations.shape[0], 77, 3) or not (2 <= len(joints) <= 1800):
        raise ValueError("Invalid SOMA position data or unsupported clip length (2-1800 frames).")
    if not np.isfinite(rotations).all() or not np.isfinite(joints).all() or not (1 <= args.fps <= 120):
        raise ValueError("Motion contains invalid numbers or frame rate.")
    if not np.allclose(rotations @ rotations.swapaxes(-1, -2), np.eye(3), atol=0.025):
        raise ValueError("Motion rotation matrices are not orthonormal.")
    result = {
        "joint_names": list(skel.bone_order_names),
        "neutral_joints": skel.neutral_joints.cpu().tolist(),
        "global_rot_mats": rotations.tolist(),
        "root_positions": joints[:, int(skel.root_idx)].tolist(),
        "fps": args.fps,
    }
if args.origin:
    with np.load(args.origin, allow_pickle=False) as data:
        origin = data["posed_joints"][0, int(skel.root_idx)]
        if origin.shape != (3,) or not np.isfinite(origin).all():
            raise ValueError("Invalid shared character-path origin.")
        result["root_origin"] = origin.tolist()
Path(args.output).write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
print(f"Prepared {len(joints)} SOMA frames at {args.fps} fps", flush=True)
