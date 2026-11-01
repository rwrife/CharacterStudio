"""Pinned, ungated encoder assets; downloads never include Llama weights."""
import hashlib
import json
from pathlib import Path

MODEL_REPO = "LiquidAI/LFM2.5-Embedding-350M"
MODEL_REVISION = "f35ae2c91d687658dbf1f2b449382f0b019b9808"
BRIDGE_REPO = "adriandj3/LFM2.5-to-Llama8B-LLM2Vec-Kimodo"
BRIDGE_REVISION = "ec840c692b7bcdffdb94a6456f26bb85e6076f8c"
MODEL_FILES = (
    "model.safetensors", "config.json", "modeling_lfm2_bidirectional.py",
    "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
    "modules.json", "sentence_bert_config.json", "config_sentence_transformers.json",
    "1_Pooling/config.json", "LICENSE",
)
BRIDGE_FILES = ("v2/bridge.py", "v2/bridge.npz", "v2/config.json", "v2/LICENSE",
                "v2/SHA256SUMS", "docs/ENCODER_RECIPE.json")


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def resolve_assets(local_only=True):
    from huggingface_hub import snapshot_download

    model = Path(snapshot_download(MODEL_REPO, revision=MODEL_REVISION,
                                  allow_patterns=list(MODEL_FILES), local_files_only=local_only, token=False))
    bridge = Path(snapshot_download(BRIDGE_REPO, revision=BRIDGE_REVISION,
                                   allow_patterns=list(BRIDGE_FILES), local_files_only=local_only, token=False))
    missing = [str(root / name) for root, names in ((model, MODEL_FILES), (bridge, BRIDGE_FILES))
               for name in names if not (root / name).is_file()]
    if missing:
        raise FileNotFoundError("Incomplete LFM installation. Run scripts\\setup-lfm.ps1. Missing: " + ", ".join(missing))
    return model, bridge


def verify_assets(model, bridge):
    recipe = json.loads((bridge / "docs" / "ENCODER_RECIPE.json").read_text(encoding="utf-8"))
    for name, identity in recipe["checkpoint_identity"]["files"].items():
        path = model / name
        if path.stat().st_size != identity["size_bytes"] or digest(path) != identity["sha256"]:
            raise ValueError(f"LFM checkpoint does not match the bridge's calibrated model: {name}")
    verified = set()
    required = {"bridge.py", "bridge.npz", "config.json", "LICENSE"}
    for line in (bridge / "v2" / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        checksum, name = line.split(maxsplit=1)
        relative = Path(name.lstrip("*"))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Invalid bridge checksum path")
        path = bridge / "v2" / relative
        # The release manifest also lists optional provenance/docs not used at runtime.
        if path.is_file() and digest(path) != checksum:
            raise ValueError(f"LFM bridge checksum mismatch: {name}")
        if path.is_file():
            verified.add(relative.as_posix())
    if not required.issubset(verified):
        raise ValueError("LFM bridge manifest does not verify every required runtime file")
    return recipe
