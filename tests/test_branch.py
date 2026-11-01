"""Exercise real Kimodo full-body constraint conversion without model downloads."""
import json
import subprocess
import sys
from pathlib import Path
import numpy as np

root = Path(__file__).resolve().parents[1]
kimodo = sys.argv[1]
fixture = root / "artifacts" / "bruiser-analytic-test" / "test-motion.npz"
output = root / "artifacts" / "branch-test"
output.mkdir(parents=True, exist_ok=True)
script = root / "backend" / "branch_motion.py"
common = ["--kimodo", kimodo, "--parent", str(fixture)]
subprocess.run([sys.executable, str(script), "condition", *common, "--output", str(output / "constraint.json")], check=True)
sys.path.insert(0, kimodo)
from kimodo.constraints import load_constraints_lst
from kimodo.skeleton import SOMASkeleton30
constraints = load_constraints_lst(str(output / "constraint.json"), SOMASkeleton30())
assert constraints[0].frame_indices.tolist() == [0]
subprocess.run([sys.executable, str(script), "stitch", *common, "--child", str(fixture), "--output", str(output / "sequence.npz")], check=True)
report = json.loads((output / "sequence.seam.json").read_text())
assert report["combinedFrames"] == 119
assert report["rootErrorMeters"] < 1e-6
with np.load(fixture, allow_pickle=False) as data:
    joints, rots = data["posed_joints"].copy(), data["global_rot_mats"].copy()
joints[0, 0, 0] += 1.0
np.savez(output / "bad-child.npz", posed_joints=joints, global_rot_mats=rots)
bad = subprocess.run([sys.executable, str(script), "stitch", *common, "--child", str(output / "bad-child.npz"), "--output", str(output / "must-not-succeed.npz")], capture_output=True, text=True)
assert bad.returncode != 0 and "did not honor" in bad.stderr
assert not (output / "must-not-succeed.npz").exists()
subprocess.run([sys.executable, str(script), "condition", *common, "--end", str(fixture), "--frames", "60", "--output", str(output / "two-endpoints.json")], check=True)
constraints = load_constraints_lst(str(output / "two-endpoints.json"), SOMASkeleton30())
assert constraints[0].frame_indices.tolist() == [0, 59]
subprocess.run([sys.executable, str(script), "verify-loop", *common, "--output", str(output / "loop.json")], check=True)
bad_loop = subprocess.run([sys.executable, str(script), "verify-loop", "--kimodo", kimodo, "--parent", str(output / "bad-child.npz"), "--output", str(output / "bad-loop.json")], capture_output=True, text=True)
assert bad_loop.returncode != 0 and not (output / "bad-loop.json").exists()
subprocess.run([sys.executable, str(script), "verify-frames", *common, "--frames", "60", "--output", str(output / "frames.json")], check=True)
bad_frames = subprocess.run([sys.executable, str(script), "verify-frames", *common, "--frames", "59", "--output", str(output / "bad-frames.json")], capture_output=True, text=True)
assert bad_frames.returncode != 0 and not (output / "bad-frames.json").exists()
yaw = 0.6
rotation = np.array([[np.cos(yaw), 0, np.sin(yaw)], [0, 1, 0], [-np.sin(yaw), 0, np.cos(yaw)]], dtype=np.float32)
parent_joints = data["posed_joints"] @ rotation.T + np.array([2, 0, 3])
parent_rots = rotation @ data["global_rot_mats"]
np.savez(output / "turned-parent.npz", posed_joints=parent_joints, global_rot_mats=parent_rots)
low_joints = data["posed_joints"].copy()
low_joints[:, :, 1] -= 0.35
np.savez(output / "low-child.npz", posed_joints=low_joints, global_rot_mats=data["global_rot_mats"])
subprocess.run([sys.executable, str(script), "align", "--kimodo", kimodo, "--parent", str(output / "turned-parent.npz"), "--child", str(output / "low-child.npz"), "--output", str(output / "aligned.npz")], check=True)
with np.load(output / "aligned.npz", allow_pickle=False) as aligned:
    np.testing.assert_allclose(aligned["posed_joints"][0, 0, [0, 2]], parent_joints[-1, 0, [0, 2]], atol=1e-5)
    np.testing.assert_allclose(aligned["posed_joints"][:, :, 1], low_joints[:, :, 1], atol=1e-5)
    np.testing.assert_allclose(aligned["global_rot_mats"][0, 0], parent_rots[-1, 0], atol=1e-5)
print("Branch tests passed: SOMA77->30 single/two-endpoint constraints, frame counts, checked assembly, loop/seam rejection, and height-preserving horizontal/heading alignment.")
