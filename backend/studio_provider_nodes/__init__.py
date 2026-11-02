"""Optional ComfyUI bridge for remote SOMA motion, without shared filesystem paths."""
import json
import tempfile
from pathlib import Path

import folder_paths
import nodes


class Studio_Kimodo_Sampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("KIMODO_MODEL",),
            "conditioning": ("KIMODO_COND",),
            "duration": ("FLOAT", {"default": 5.0, "min": 0.5, "max": 30.0}),
            "seed": ("INT", {"default": 42, "min": 0, "max": 2**32 - 1}),
            "num_samples": ("INT", {"default": 1, "min": 1, "max": 1}),
            "diffusion_steps": ("INT", {"default": 100, "min": 10, "max": 500}),
            "constraints_json": ("STRING", {"default": "{}"}),
        }}

    RETURN_TYPES = ("KIMODO_MOTION",)
    FUNCTION = "sample"
    CATEGORY = "Character Studio"

    def sample(self, model, conditioning, duration, seed, num_samples,
               diffusion_steps, constraints_json):
        if len(constraints_json) > 5 * 1024 * 1024:
            raise ValueError("Inline motion constraints exceed 5 MB.")
        constraints = json.loads(constraints_json)
        if not isinstance(constraints, (list, dict)):
            raise ValueError("Inline constraints must be a JSON object or list, not a path.")
        sampler = nodes.NODE_CLASS_MAPPINGS.get("Kimodo_Sampler")
        if sampler is None:
            raise RuntimeError("Install ComfyUI-Kimodo and restart ComfyUI.")
        with tempfile.TemporaryDirectory(prefix="studio-constraints-") as directory:
            path = ""
            if constraints:
                file = Path(directory) / "constraints.json"
                file.write_text(json.dumps(constraints, allow_nan=False), encoding="utf-8")
                path = str(file)
            return sampler().sample(
                model, conditioning, duration=duration, seed=seed, num_samples=num_samples,
                diffusion_steps=diffusion_steps, constraints_json=path,
            )


class Studio_MotionFile:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"file_path": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ()
    FUNCTION = "describe"
    CATEGORY = "Character Studio"
    OUTPUT_NODE = True

    def describe(self, file_path):
        root = Path(folder_paths.get_output_directory()).resolve(strict=True)
        path = Path(file_path).resolve(strict=True)
        relative = path.relative_to(root)
        if path.suffix.lower() not in (".npz", ".bvh") or not path.is_file():
            raise ValueError("Expected a generated NPZ or BVH in the ComfyUI output folder.")
        if not path.name.startswith("studio_") or not 0 < path.stat().st_size <= 500 * 1024 * 1024:
            raise ValueError("Invalid Studio motion output.")
        subfolder = relative.parent.as_posix()
        return {"ui": {"files": [{
            "filename": path.name, "subfolder": "" if subfolder == "." else subfolder,
            "type": "output",
        }]}}


NODE_CLASS_MAPPINGS = {
    "Studio_Kimodo_Sampler": Studio_Kimodo_Sampler,
    "Studio_MotionFile": Studio_MotionFile,
}
