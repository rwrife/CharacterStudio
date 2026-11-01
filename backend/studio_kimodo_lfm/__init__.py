"""ComfyUI loader that changes only Kimodo's text-conditioning encoder."""
from pathlib import Path
import sys


class Studio_Kimodo_LoadLFM:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": (["Kimodo-SOMA-RP-v1"],)}}

    RETURN_TYPES = ("KIMODO_MODEL",)
    FUNCTION = "load"
    CATEGORY = "Kimodo/Experimental"

    def load(self, model):
        import folder_paths
        import comfy.model_management as mm
        from omegaconf import OmegaConf

        node_root = Path(folder_paths.base_path) / "custom_nodes" / "ComfyUI-Kimodo" / "kimodo"
        if not node_root.is_dir():
            raise FileNotFoundError("Install ComfyUI-Kimodo in the selected ComfyUI backend before using LFM.")
        for directory in (str(node_root), str(Path(__file__).resolve().parent.parent)):
            if directory not in sys.path:
                sys.path.insert(0, directory)
        from kimodo.model.registry import get_short_key_from_display_name, MODEL_NAMES
        from kimodo.model.loading import instantiate_from_dict
        from huggingface_hub import snapshot_download

        key = get_short_key_from_display_name(model)
        if key is None or key not in MODEL_NAMES:
            raise ValueError(f"Unsupported Kimodo model: {model}")
        checkpoint = Path(folder_paths.models_dir) / "Kimodo" / model
        if not checkpoint.is_dir():
            checkpoint = Path(snapshot_download(MODEL_NAMES[key]))
        config = OmegaConf.load(checkpoint / "config.yaml")
        runtime = OmegaConf.create({
            "checkpoint_dir": str(checkpoint),
            "text_encoder": {"_target_": "studio_kimodo_lfm.encoder.LFMBridgeEncoder"},
        })
        merged = OmegaConf.to_container(OmegaConf.merge(config, runtime), resolve=True)
        merged.pop("checkpoint_dir", None)
        loaded = instantiate_from_dict(merged, overrides={"device": str(mm.get_torch_device())}).eval()
        return (loaded,)


NODE_CLASS_MAPPINGS = {"Studio_Kimodo_LoadLFM": Studio_Kimodo_LoadLFM}
NODE_DISPLAY_NAME_MAPPINGS = {"Studio_Kimodo_LoadLFM": "Kimodo + LFM bridge (experimental)"}
