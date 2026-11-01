"""Download pinned public assets and install Studio's scoped ComfyUI node."""
import argparse
from pathlib import Path
import shutil

from studio_kimodo_lfm.assets import resolve_assets, verify_assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy", type=Path, required=True)
    args = parser.parse_args()
    if not (args.comfy / "main.py").is_file() or not (args.comfy / "custom_nodes" / "ComfyUI-Kimodo" / "nodes.py").is_file():
        raise FileNotFoundError("Select an existing ComfyUI installation containing ComfyUI-Kimodo.")
    model, bridge = resolve_assets(local_only=False)
    verify_assets(model, bridge)
    source = Path(__file__).resolve().parent / "studio_kimodo_lfm"
    target = args.comfy / "custom_nodes" / "studio_kimodo_lfm"
    target.mkdir(exist_ok=True)
    for name in ("__init__.py", "assets.py", "encoder.py"):
        shutil.copy2(source / name, target / name)
    print("Pinned LFM model and bridge verified; Studio_Kimodo_LoadLFM installed.")
    print("Restart ComfyUI, then choose LFM bridge (experimental) in Backend connections.")


if __name__ == "__main__":
    main()
