"""Read-only environment/access probe. Never print or accept credentials."""
import json
import argparse
import sys
from pathlib import Path


def check_text_encoder():
    from httpx import TransportError
    from huggingface_hub import get_token, try_to_load_from_cache, get_hf_file_metadata, hf_hub_url
    from huggingface_hub.errors import GatedRepoError, HfHubHTTPError, LocalTokenNotFoundError

    repo = "meta-llama/Meta-Llama-3-8B-Instruct"
    filename = "model-00001-of-00004.safetensors"
    cached = [try_to_load_from_cache(repo, f"model-{i:05d}-of-00004.safetensors") for i in range(1, 5)]
    status = "blocked"
    if all(isinstance(p, str) and Path(p).is_file() for p in cached):
        status = "ready"
        detail = "All four base-model weight shards are cached locally. Inference runs on this PC. Tokenizer/configuration and LLM2Vec adapters must also be available when generating."
    else:
        token = get_token()
        if not token:
            detail = "Local weights are missing and no Hugging Face login was found. Request access to Meta-Llama-3-8B-Instruct, then run hf auth login in the ComfyUI environment with the same account. Browser login alone does not sign in this PC."
        else:
            try:
                get_hf_file_metadata(hf_hub_url(repo, filename), token=token, timeout=15)
                status = "warning"
                detail = "Download access authorized. First generation downloads local Llama/LLM2Vec weights (many GB); inference runs on this PC."
            except GatedRepoError:
                detail = "Hugging Face denied access to Meta-Llama-3-8B-Instruct. The account may still need model-owner approval, or its token may lack gated-model read permission. Check the exact model page and use the same approved account locally."
            except LocalTokenNotFoundError:
                detail = "Hugging Face could not find local credentials. Sign in with hf auth login in the ComfyUI environment using the approved account."
            except HfHubHTTPError as exc:
                code = getattr(exc.response, "status_code", None)
                if code == 401:
                    detail = "Hugging Face rejected the local login (HTTP 401). The token may be expired or invalid. Sign in again with hf auth login --force using the approved account."
                elif code == 403:
                    detail = "Hugging Face refused this download (HTTP 403). Check model approval, the active account, and the token's read permission for gated repositories."
                else:
                    detail = f"Hugging Face access check returned HTTP {code}. This does not establish whether model approval is missing. Check service/network availability and retry."
            except (OSError, TimeoutError, TransportError) as exc:
                detail = f"Could not reach Hugging Face to verify access ({type(exc).__name__}). Check the network and retry; this is not evidence that model access was denied."
    if status == "blocked":
        detail += " See Backend connections > Model access & local setup. Never paste a token into Studio or chat."
    return {"name": "Local Llama text encoder", "status": status, "detail": detail}


def check_lfm_encoder():
    from huggingface_hub.errors import LocalEntryNotFoundError
    from studio_kimodo_lfm.assets import resolve_assets

    try:
        resolve_assets()
    except (LocalEntryNotFoundError, FileNotFoundError):
        return {"name": "Local LFM text encoder", "status": "blocked",
                "detail": "Pinned LFM weights/bridge are not completely cached. Run scripts\\setup-lfm.ps1 with your saved ComfyUI folder, then restart ComfyUI. No Llama approval or Hugging Face login is required. See Model access & local setup."}
    return {"name": "Local LFM text encoder", "status": "warning",
            "detail": "Pinned ungated LFM weights and bridge are cached. Inference remains local. Experimental conditioning can change motion details; inspect handedness, stance and graph seams. LFM's custom license has a commercial revenue limitation. Integrity and model compatibility are checked when loading."}


def check_gpu():
    import torch

    if not torch.cuda.is_available():
        return {"name": "PyTorch / GPU", "status": "warning",
                "detail": f"torch {torch.__version__}; CUDA unavailable (CPU generation is slow). GPU memory guidance is unavailable."}
    device = torch.cuda.current_device()
    name = torch.cuda.get_device_name(device)
    try:
        free, total = torch.cuda.mem_get_info(device)
    except RuntimeError as exc:
        return {"name": "PyTorch / GPU", "status": "warning",
                "detail": f"torch {torch.__version__}; CUDA available, but GPU memory detection failed ({type(exc).__name__}). Refresh readiness or inspect the GPU driver; choose the encoder manually."}
    gpu = {"name": name, "totalGB": total / 1024 ** 3, "freeGB": free / 1024 ** 3}
    return {"name": "PyTorch / GPU", "status": "ready", "gpu": gpu,
            "detail": f"torch {torch.__version__}; {name}; {gpu['freeGB']:.1f} GiB free / {gpu['totalGB']:.1f} GiB total GPU memory."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--encoder", choices=("llm2vec", "lfm"), default="llm2vec")
    parser.add_argument("--processing-only", action="store_true")
    parser.add_argument("--kimodo")
    args = parser.parse_args()
    if args.processing_only:
        if not args.kimodo:
            raise ValueError("Motion processing requires a local Kimodo source folder.")
        sys.path.insert(0, args.kimodo)
        import numpy
        import torch
        from kimodo.skeleton import SOMASkeleton77
        from kimodo.constraints import FullBodyConstraintSet
        from kimodo.exports.bvh import save_motion_bvh
        SOMASkeleton77()
        print("STUDIO_CHECKS:[]", flush=True)
        return
    checks = [check_gpu()]
    checks.append(check_lfm_encoder() if args.encoder == "lfm" else check_text_encoder())
    print("STUDIO_CHECKS:" + json.dumps(checks), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("STUDIO_CHECKS:" + json.dumps([{"name": "Comfy Python", "status": "blocked",
              "detail": f"Environment probe failed: {type(exc).__name__}: {exc}"}]), flush=True)
        sys.exit(1)
