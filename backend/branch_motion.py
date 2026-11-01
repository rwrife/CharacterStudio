"""Real endpoint conditioning and validated full-branch assembly for SOMA motion."""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

parser = argparse.ArgumentParser()
parser.add_argument("command", choices=["condition", "stitch", "align", "verify-loop", "verify-frames"])
parser.add_argument("--kimodo", required=True)
parser.add_argument("--parent", required=True)
parser.add_argument("--child")
parser.add_argument("--parent-frame", choices=["first", "last"], default="last")
parser.add_argument("--end")
parser.add_argument("--frames", type=int)
parser.add_argument("--output", required=True)
parser.add_argument("--fps", type=float, default=30)
args = parser.parse_args()
sys.path.insert(0, args.kimodo)
from kimodo.skeleton import SOMASkeleton77
from kimodo.constraints import FullBodyConstraintSet, save_constraints_lst, load_constraints_lst
from kimodo.exports.bvh import save_motion_bvh

skel = SOMASkeleton77()


def read_motion(path):
    with np.load(path, allow_pickle=False) as data:
        joints, rots = data["posed_joints"], data["global_rot_mats"]
        if joints.ndim != 3 or joints.shape[1:] != (77, 3) or rots.shape != joints.shape[:2] + (3, 3):
            raise ValueError("Branch input must be a single SOMA-77 motion.")
        if len(joints) < 2 or not (np.isfinite(joints).all() and np.isfinite(rots).all()):
            raise ValueError("Branch input has invalid frames or non-finite values.")
        if not np.allclose(rots @ rots.swapaxes(-1, -2), np.eye(3), atol=0.025):
            raise ValueError("Branch rotations must be orthonormal.")
        return joints, rots


def seam(left_joints, left_rots, right_joints, right_rots):
    body_names = {"Hips", "Spine1", "Spine2", "Chest", "Neck1", "Head"}
    for side in ("Left", "Right"):
        body_names.update(side + suffix for suffix in ("Shoulder", "Arm", "ForeArm", "Hand", "Leg", "Shin", "Foot", "ToeBase"))
    indices = [i for i, name in enumerate(skel.bone_order_names) if name in body_names]
    delta = np.swapaxes(left_rots[indices], -1, -2) @ right_rots[indices]
    max_angle = float(np.arccos(np.clip((np.trace(delta, axis1=-2, axis2=-1) - 1) / 2, -1, 1)).max())
    root_error = float(np.linalg.norm(left_joints[skel.root_idx] - right_joints[skel.root_idx]))
    if root_error > 0.02 or max_angle > np.deg2rad(5):
        raise ValueError(
            f"Generated motion did not honor its endpoint pose (root {root_error:.3f}m; body rotation {np.rad2deg(max_angle):.1f} degrees). "
            "No continuous-path or loop success was published. Retry with a different seed or more steps."
        )
    return {"rootErrorMeters": root_error, "maximumBodyRotationErrorDegrees": float(np.rad2deg(max_angle))}


def save_motion(joints, rots):
    np.savez(args.output, posed_joints=joints, global_rot_mats=rots)
    global_rots = torch.tensor(rots, dtype=torch.float32)
    save_motion_bvh(
        str(Path(args.output).with_suffix(".bvh")),
        skel.global_rots_to_local_rots(global_rots),
        torch.tensor(joints[:, skel.root_idx], dtype=torch.float32),
        skeleton=skel, fps=args.fps,
    )


parent_joints, parent_rots = read_motion(args.parent)
if args.command == "verify-frames":
    if not args.frames or not 2 <= args.frames <= 1800 or len(parent_joints) != args.frames:
        raise ValueError(f"Motion file has {len(parent_joints)} frames; expected {args.frames}. No completed result was published.")
    Path(args.output).write_text(json.dumps({"frames": len(parent_joints)}), encoding="utf-8")
elif args.command == "condition":
    index = 0 if args.parent_frame == "first" else -1
    frames = [0]
    joints, rots = parent_joints[index:index + 1] if index == 0 else parent_joints[-1:], parent_rots[:1] if index == 0 else parent_rots[-1:]
    if args.end:
        if not args.frames or not 2 <= args.frames <= 1800:
            raise ValueError("Two-endpoint conditioning requires 2-1800 frames.")
        end_joints, end_rots = read_motion(args.end)
        frames.append(args.frames - 1)
        joints, rots = np.concatenate([joints, end_joints[:1]]), np.concatenate([rots, end_rots[:1]])
    constraint = FullBodyConstraintSet(
        skel, torch.tensor(frames),
        torch.tensor(joints, dtype=torch.float32),
        torch.tensor(rots, dtype=torch.float32),
    )
    save_constraints_lst(args.output, [constraint])
    loaded = load_constraints_lst(args.output, skel)
    assert len(loaded) == 1 and loaded[0].frame_indices.tolist() == frames
    print(f"Conditioned frames {frames} on actual full-body poses, root heights, positions and headings.")
elif args.command == "verify-loop":
    report = seam(parent_joints[-1], parent_rots[-1], parent_joints[0], parent_rots[0])
    report["velocityContinuityGuaranteed"] = False
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("Loop endpoint poses verified; velocity continuity still requires visual review.")
elif args.command == "align":
    if not args.child:
        raise ValueError("A state clip is required to align.")
    joints, rots = read_motion(args.child)
    source = parent_rots[-1, skel.root_idx]
    target = rots[0, skel.root_idx]
    yaw = np.arctan2(source[0, 2], source[2, 2]) - np.arctan2(target[0, 2], target[2, 2])
    c, s = np.cos(yaw), np.sin(yaw)
    rotation = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=rots.dtype)
    origin = joints[0, skel.root_idx].copy()
    origin[1] = 0
    destination = parent_joints[-1, skel.root_idx].copy()
    destination[1] = 0
    joints = (joints - origin) @ rotation.T + destination
    rots = rotation @ rots
    save_motion(joints, rots)
    print("State clip aligned horizontally to the incoming pose; destination posture and root height preserved.")
elif args.command == "stitch":
    if not args.child:
        raise ValueError("A child motion is required for branch assembly.")
    child_joints, child_rots = read_motion(args.child)
    report = seam(parent_joints[-1], parent_rots[-1], child_joints[0], child_rots[0])
    joints = np.concatenate([parent_joints, child_joints[1:]])
    rots = np.concatenate([parent_rots, child_rots[1:]])
    if len(joints) > 1800:
        raise ValueError("Combined branch exceeds the 60-second motion limit.")
    save_motion(joints, rots)
    Path(args.output).with_suffix(".seam.json").write_text(json.dumps({
        "parentFrames": len(parent_joints), "childFrames": len(child_joints), "combinedFrames": len(joints),
        **report,
        "duplicateEndpointRemoved": True
    }, indent=2), encoding="utf-8")
    print(f"Validated and assembled {len(joints)} full-branch frames; parent clip unchanged.")
